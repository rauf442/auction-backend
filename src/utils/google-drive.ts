// backend/src/utils/google-drive.ts
// Purpose: Google Drive helper utilities for folder management, file upload, sharing, and listing.

import { google } from 'googleapis'

export interface DriveFileInfo {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
  webContentLink?: string
  createdTime?: string
}

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
    } as any,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  })
  const drive = google.drive({ version: 'v3', auth })
  return drive
}

export function extractDriveFolderId(urlOrId: string): string {
  if (!urlOrId) return ''
  // If it's already an ID-like token, return as is
  if (/^[A-Za-z0-9_-]{10,}$/.test(urlOrId) && !urlOrId.includes('http')) return urlOrId
  // Common folder URL formats
  // https://drive.google.com/drive/folders/{ID}
  // https://drive.google.com/drive/u/0/folders/{ID}
  // https://drive.google.com/drive/u/0/my-drive/{ID}
  const m = urlOrId.match(/\/folders\/([A-Za-z0-9_-]+)/)
  if (m && m[1]) return m[1]
  // Shared drive URL format: https://drive.google.com/open?id={ID}
  const m2 = urlOrId.match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (m2 && m2[1]) return m2[1]
  return urlOrId
}

export async function ensureFolder(folderName: string, parentId?: string): Promise<string> {
  const drive = getDriveClient()
  // Try to find existing folder by name under parent
  const qParts = [`mimeType = 'application/vnd.google-apps.folder'`, `name = '${folderName.replace(/'/g, "\\'")}'`, 'trashed = false']
  if (parentId) qParts.push(`'${parentId}' in parents`)
  const q = qParts.join(' and ')
  const list = await drive.files.list({ q, fields: 'files(id,name)' })
  const existing = list.data.files?.[0]
  if (existing?.id) return existing.id
  // Create
  const create = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  })
  return create.data.id as string
}

export async function setFilePublic(fileId: string): Promise<void> {
  const drive = getDriveClient()
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    })
  } catch (e) {
    // Ignore permission errors (e.g., if not owner)
  }
}

export function buildDriveDirectViewUrl(fileId: string): string {
  // Use the universal Google Drive direct view URL format
  // This format works reliably for publicly shared images across all contexts
  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

export async function uploadBufferToFolder(
  folderId: string,
  filename: string,
  buffer: Buffer,
  mimeType = 'image/jpeg'
): Promise<DriveFileInfo> {
  const drive = getDriveClient()
  const response = (await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Buffer.from(buffer) as any },
    fields: 'id,name,mimeType,webViewLink,webContentLink,createdTime',
  } as any)) as any
  const info: DriveFileInfo = response.data as any
  try { await setFilePublic(info.id) } catch {}
  return info
}

export async function listFilesInFolder(folderUrlOrId: string): Promise<DriveFileInfo[]> {
  const drive = getDriveClient()
  const folderId = extractDriveFolderId(folderUrlOrId)
  const files: DriveFileInfo[] = []
  let pageToken: string | undefined = undefined
  do {
    const res: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink,webContentLink,createdTime)',
      pageSize: 1000,
      pageToken,
    })
    const batch = (res.data.files || []) as any
    files.push(...batch)
    pageToken = res.data.nextPageToken || undefined
  } while (pageToken)
  return files
}

// Normalize a Drive filename to an item key.
// Supports patterns like: 1, 1a, 1-a, 1 (a), inv-1, inv_001, item1, etc.
// Also supports: IMG_123.jpg, DSC0123.jpg, Photo123.jpg, artwork-123.png, etc.
// Enhanced to support numeric suffixes: 12-1, 12 (1), 12-2, 12-3, etc.
// Examples: 12-1, 12 (1), 12-A, 12 (A), item-123-2, IMG_456 (3), etc.
export function deriveItemIdKeyFromFilename(name: string): string | null {
  if (!name) return null

  // Remove file extension
  const base = name.toLowerCase().replace(/\.(jpg|jpeg|png|webp|tiff|gif|bmp|svg)$/i, '')

  // Pattern 1: Explicit prefixes (most reliable)
  let m = base.match(/^(?:inv|item|artwork|img|dsc|photo|pic|image)[-_\s]*(\d{1,6})/i)
  if (m && m[1]) return String(parseInt(m[1], 10))

  // Pattern 2: Numbers with suffixes (enhanced to support numeric suffixes)
  // Matches: 12-1, 12 (1), 12-a, 12 (a), etc.
  m = base.match(/(\d{1,6})(?:[-_\s]*\(?([a-z0-9])\)?)?$/i)
  if (m && m[1]) return String(parseInt(m[1], 10))

  // Pattern 3: Numbers at the end (common pattern)
  m = base.match(/(\d{1,6})[-_\s]*$/)
  if (m && m[1]) return String(parseInt(m[1], 10))

  // Pattern 4: Numbers in the middle with separators
  m = base.match(/(\d{1,6})[-_\s]/)
  if (m && m[1]) return String(parseInt(m[1], 10))

  // Pattern 5: Any standalone number (fallback)
  m = base.match(/\b(\d{1,6})\b/)
  if (m && m[1]) return String(parseInt(m[1], 10))

  console.log(`Could not extract item ID from filename: "${name}" (base: "${base}")`)
  return null
}


