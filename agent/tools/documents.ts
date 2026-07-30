import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const DATA_DIR = resolve(process.env.ASSISTANT_DATA_DIR ?? "data");
const DB_FILE = join(DATA_DIR, "documents", "documents.sqlite");
const VAULT_DIR = resolve(process.env.ASSISTANT_VAULT_DIR ?? "vault");
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const CHUNK_CHARS = 2400;
const CHUNK_OVERLAP = 200;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
]);
const PANDOC_EXTENSIONS = new Set([".docx", ".odt", ".rtf", ".epub", ".html", ".htm"]);

interface DocumentRow {
  id: number;
  title: string;
  file_name: string;
  source_path: string;
  content_hash: string;
  text_chars: number;
  chunk_count: number;
  indexed_at: string;
}

interface SearchRow {
  document_id: number;
  title: string;
  file_name: string;
  indexed_at: string;
  excerpt: string;
  rank: number;
}

const XLSX_EXTRACTOR = String.raw`
import sys, zipfile, xml.etree.ElementTree as ET
p = sys.argv[1]
ns = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'pr':'http://schemas.openxmlformats.org/package/2006/relationships'}
with zipfile.ZipFile(p) as z:
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', ns):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % ns['m'])))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    relroot = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rels = {x.attrib['Id']: x.attrib['Target'] for x in relroot}
    for sheet in wb.find('m:sheets', ns):
        name = sheet.attrib.get('name', 'Sheet')
        rid = sheet.attrib.get('{%s}id' % ns['r'])
        target = rels.get(rid, '')
        target = target.lstrip('/') if target.startswith('/xl/') else 'xl/' + target.lstrip('/')
        target = target.replace('xl/xl/', 'xl/')
        print('\n### ' + name)
        root = ET.fromstring(z.read(target))
        for row in root.findall('.//m:sheetData/m:row', ns):
            values = []
            for c in row.findall('m:c', ns):
                typ = c.attrib.get('t')
                if typ == 'inlineStr':
                    val = ''.join(t.text or '' for t in c.iter('{%s}t' % ns['m']))
                else:
                    v = c.find('m:v', ns)
                    val = '' if v is None or v.text is None else v.text
                    if typ == 's' and val:
                        try: val = shared[int(val)]
                        except (ValueError, IndexError): pass
                values.append(val.replace('\n', ' '))
            if any(values): print('\t'.join(values))
`;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      text_chars INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
      document_id UNINDEXED,
      chunk_no UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

function resolveVaultPath(input: string): string {
  const full = resolve(input);
  if (full !== VAULT_DIR && !full.startsWith(VAULT_DIR + sep)) {
    throw new Error(`Можно индексировать только файлы из vault: ${VAULT_DIR}`);
  }
  return full;
}

async function extractText(path: string): Promise<string> {
  const extension = extname(path).toLowerCase();
  let text: string;

  if (TEXT_EXTENSIONS.has(extension)) {
    text = await readFile(path, "utf8");
  } else if (extension === ".pdf") {
    const result = await runFile("pdftotext", ["-layout", path, "-"], {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    text = result.stdout;
  } else if (PANDOC_EXTENSIONS.has(extension)) {
    const result = await runFile("pandoc", [path, "-t", "plain", "--wrap=none"], {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    text = result.stdout;
  } else if (extension === ".xlsx") {
    const result = await runFile("python3", ["-c", XLSX_EXTRACTOR, path], {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    text = result.stdout;
  } else {
    throw new Error(
      `Формат ${extension || "без расширения"} не поддерживается. ` +
        "Поддерживаются PDF, DOCX, RTF, ODT, XLSX, TXT, MD, CSV и JSON.",
    );
  }

  return text
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function chunks(text: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    result.push(text.slice(start, start + CHUNK_CHARS));
    if (start + CHUNK_CHARS >= text.length) break;
  }
  return result;
}

function searchExpression(query: string): string {
  const raw = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((x) => x.length > 1).slice(0, 10);
  const terms = new Set<string>();
  for (const word of raw) {
    terms.add(word);
    if (/^[а-яё]+$/u.test(word) && word.length > 5) {
      const stem = word.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ов|ев|ая|яя|ое|ее|ые|ие|ый|ий|ой|ам|ям|ом|ем|ую|юю|а|я|ы|и|е|о|у|ю)$/u, "");
      if (stem.length >= 4) terms.add(stem);
    }
  }
  if (terms.size === 0) throw new Error("Запрос слишком короткий");
  return [...terms].map((x) => `"${x}"*`).join(" OR ");
}

export default defineTool({
  description:
    "Локальная база документов пользователя. add индексирует присланный файл из vault; " +
    "search ищет по содержимому; read читает текст документа; list показывает документы; " +
    "remove удаляет документ из индекса. " +
    "Поддерживает PDF, DOCX/RTF/ODT, XLSX, TXT/MD/CSV/JSON. Не добавляй файл без явной просьбы пользователя.",
  inputSchema: z.object({
    action: z.enum(["add", "search", "read", "list", "remove"]),
    path: z.string().min(1).optional().describe("Путь к файлу в vault для add"),
    title: z.string().min(1).max(300).optional().describe("Название документа для add"),
    query: z.string().min(1).optional().describe("Поисковый запрос для search"),
    id: z.number().int().positive().optional().describe("ID документа для read/remove"),
    offset: z.number().int().min(0).optional().describe("Номер первого фрагмента для read (с нуля)"),
    limit: z.number().int().min(1).max(20).optional().describe("Число результатов или фрагментов"),
  }),
  async execute({ action, path, title, query, id, offset, limit }) {
    await mkdir(join(DATA_DIR, "documents"), { recursive: true });
    const db = openDb();
    try {
      if (action === "add") {
        if (!path) return { ok: false, error: "Для add нужен path" };
        const fullPath = resolveVaultPath(path);
        const info = await stat(fullPath);
        if (!info.isFile()) return { ok: false, error: "Указанный путь не является файлом" };
        if (info.size > MAX_FILE_BYTES) return { ok: false, error: "Файл больше 20 МБ" };

        const bytes = await readFile(fullPath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const existing = db.prepare("SELECT * FROM documents WHERE content_hash = ?").get(hash) as
          | DocumentRow
          | undefined;
        if (existing) return { ok: true, alreadyIndexed: true, document: existing };

        const text = await extractText(fullPath);
        if (!text) return { ok: false, error: "В документе не удалось извлечь текст" };
        const parts = chunks(text);
        const indexedAt = new Date().toISOString();
        const fileName = basename(fullPath);

        db.exec("BEGIN IMMEDIATE");
        try {
          const inserted = db
            .prepare(
              "INSERT INTO documents(title,file_name,source_path,content_hash,text_chars,chunk_count,indexed_at) " +
                "VALUES(?,?,?,?,?,?,?)",
            )
            .run(title ?? fileName, fileName, fullPath, hash, text.length, parts.length, indexedAt);
          const documentId = Number(inserted.lastInsertRowid);
          const addChunk = db.prepare(
            "INSERT INTO document_chunks(document_id,chunk_no,content) VALUES(?,?,?)",
          );
          parts.forEach((content, chunkNo) => addChunk.run(documentId, chunkNo, content));
          db.exec("COMMIT");
          return {
            ok: true,
            document: { id: documentId, title: title ?? fileName, fileName, textChars: text.length, chunks: parts.length },
            truncated: text.length === MAX_TEXT_CHARS,
          };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }

      if (action === "search") {
        if (!query) return { ok: false, error: "Для search нужен query" };
        const rows = db
          .prepare(
            `SELECT d.id AS document_id, d.title, d.file_name, d.indexed_at,
                    snippet(document_chunks, 2, '[', ']', ' ... ', 32) AS excerpt,
                    bm25(document_chunks) AS rank
             FROM document_chunks
             JOIN documents d ON d.id = document_chunks.document_id
             WHERE document_chunks MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(searchExpression(query), (limit ?? 5) * 3) as unknown as SearchRow[];
        const seen = new Set<number>();
        const results = rows.filter((row) => !seen.has(row.document_id) && seen.add(row.document_id)).slice(0, limit ?? 5);
        return { ok: true, query, count: results.length, results };
      }

      if (action === "list") {
        const documents = db
          .prepare(
            "SELECT id,title,file_name,text_chars,chunk_count,indexed_at FROM documents ORDER BY id DESC LIMIT ?",
          )
          .all(limit ?? 20);
        return { ok: true, count: documents.length, documents };
      }

      if (action === "read") {
        if (!id) return { ok: false, error: "Для read нужен id" };
        const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
        if (!document) return { ok: false, error: `Документ ${id} не найден` };
        const start = offset ?? 0;
        const take = Math.min(limit ?? 6, 10);
        const rows = db
          .prepare(
            "SELECT chunk_no,content FROM document_chunks WHERE document_id = ? ORDER BY chunk_no LIMIT ? OFFSET ?",
          )
          .all(id, take, start) as unknown as Array<{ chunk_no: number; content: string }>;
        return {
          ok: true,
          document: { id: document.id, title: document.title, fileName: document.file_name },
          offset: start,
          chunks: rows,
          nextOffset: start + rows.length,
          hasMore: start + rows.length < document.chunk_count,
        };
      }

      if (!id) return { ok: false, error: "Для remove нужен id" };
      const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
      if (!document) return { ok: false, error: `Документ ${id} не найден` };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { ok: true, removed: { id: document.id, title: document.title }, note: "Исходный файл в vault сохранён" };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error).slice(0, 500) };
    } finally {
      db.close();
    }
  },
});
