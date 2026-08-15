/**
 * Google Drive indexing for digital curriculum.
 *
 * Walks a shared folder and records every file as a catalog item, so PDFs,
 * worksheets, and lesson plans turn up in the same search as the books and get
 * used by the Ask tab when planning.
 *
 * Nothing is downloaded or copied — the index holds names, folder paths, and a
 * link back to Drive. Google-native docs additionally get their text extracted,
 * because Drive can export those directly and it makes search far better than
 * filenames alone.
 *
 * Setup: share the folder with the service account (Viewer is enough) — the
 * same address the Sheet is shared with.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT } from 'google-auth-library';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://www.googleapis.com/drive/v3';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Google-native types Drive can export as plain text. */
const EXPORTABLE = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

/** Human labels for the file types a homeschool folder actually contains. */
const TYPE_LABELS = {
  'application/pdf': 'PDF',
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/epub+zip': 'EPUB',
  'image/jpeg': 'Image',
  'image/png': 'Image',
  'video/mp4': 'Video',
  'audio/mpeg': 'Audio',
  'text/plain': 'Text',
};

function keyFilePath() {
  const explicit = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(REPO_ROOT, explicit);
  const found = fs.readdirSync(REPO_ROOT).find((f) => {
    if (!f.endsWith('.json') || f.startsWith('package')) return false;
    try {
      return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).type === 'service_account';
    } catch {
      return false;
    }
  });
  return found ? path.join(REPO_ROOT, found) : null;
}

export function isConfigured() {
  const kf = keyFilePath();
  return Boolean(kf && fs.existsSync(kf));
}

export function serviceAccountEmail() {
  try {
    return JSON.parse(fs.readFileSync(keyFilePath(), 'utf8')).client_email;
  } catch {
    return null;
  }
}

let cachedClient = null;
async function token() {
  if (!cachedClient) {
    const creds = JSON.parse(fs.readFileSync(keyFilePath(), 'utf8'));
    cachedClient = new JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    await cachedClient.authorize();
  }
  const { token: t } = await cachedClient.getAccessToken();
  return t;
}

async function call(url, { raw = false } = {}) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body)?.error?.message || detail; } catch { /* raw */ }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Drive returned ${res.status}. Share the folder with ${serviceAccountEmail()} ` +
          `(Viewer is enough). Original message: ${detail}`
      );
    }
    throw new Error(`Drive API ${res.status}: ${detail}`);
  }
  return raw ? res.text() : res.json();
}

/** Find a folder by name, so you don't have to hunt for its id. */
export async function findFolders(name) {
  const q = `mimeType='${FOLDER_MIME}' and trashed=false` +
    (name ? ` and name contains '${String(name).replace(/'/g, "\\'")}'` : '');
  const data = await call(
    `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=25` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
  );
  return data.files || [];
}

/** Everything the service account can see at the top level — a discovery aid. */
export async function listShared() {
  const data = await call(
    `${API}/files?q=trashed=false&fields=files(id,name,mimeType)&pageSize=50` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
  );
  return data.files || [];
}

async function listChildren(folderId) {
  const out = [];
  let pageToken = null;
  do {
    const q = `'${folderId}' in parents and trashed=false`;
    const url =
      `${API}/files?q=${encodeURIComponent(q)}` +
      `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails)` +
      `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await call(url);
    out.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Walk a folder tree, returning one record per file with its path.
 * `onProgress` is called as folders are entered so a CLI can show movement.
 */
export async function walk(folderId, { onProgress, maxDepth = 12 } = {}) {
  const files = [];
  const seen = new Set(); // guard against shortcut loops

  async function recurse(id, prefix, depth) {
    if (depth > maxDepth || seen.has(id)) return;
    seen.add(id);

    let children;
    try {
      children = await listChildren(id);
    } catch (err) {
      // A single unreadable subfolder shouldn't abort the whole index.
      onProgress?.({ type: 'error', path: prefix, message: err.message });
      return;
    }

    for (const f of children) {
      // Follow shortcuts to whatever they point at.
      const mime = f.mimeType === SHORTCUT_MIME ? f.shortcutDetails?.targetMimeType : f.mimeType;
      const realId = f.mimeType === SHORTCUT_MIME ? f.shortcutDetails?.targetId : f.id;
      if (!realId) continue;

      if (mime === FOLDER_MIME) {
        onProgress?.({ type: 'folder', path: `${prefix}/${f.name}` });
        await recurse(realId, `${prefix}/${f.name}`, depth + 1);
      } else {
        files.push({
          id: realId,
          name: f.name,
          mimeType: mime,
          typeLabel: TYPE_LABELS[mime] || (mime || '').split('/').pop() || 'File',
          size: f.size ? Number(f.size) : null,
          modified: f.modifiedTime || null,
          link: f.webViewLink || `https://drive.google.com/file/d/${realId}/view`,
          folder: prefix,
          path: `${prefix}/${f.name}`,
        });
      }
    }
  }

  const root = await call(`${API}/files/${folderId}?fields=id,name&supportsAllDrives=true`);
  onProgress?.({ type: 'root', name: root.name });
  await recurse(folderId, root.name, 0);
  return { rootName: root.name, files };
}

/**
 * Pull the text out of a Google-native doc. Returns null for anything else —
 * PDFs and Office files would need a parser, and filenames plus folder paths
 * already make those findable.
 */
export async function extractText(file, { maxChars = 4000 } = {}) {
  const exportAs = EXPORTABLE[file.mimeType];
  if (!exportAs) return null;
  try {
    const text = await call(
      `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`,
      { raw: true }
    );
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars) || null;
  } catch {
    return null; // export can fail on very large or odd docs; not fatal
  }
}

export { TYPE_LABELS };
