import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeApprovedToolFingerprint } from './permissionUtils';
import { log } from '../utils/Logger';

export interface PermissionStoreData {
  approvedCommands: string[];
  approvedTools: string[];
}

const DEFAULT_DATA: PermissionStoreData = {
  approvedCommands: [],
  approvedTools: [],
};

/** Shared across VS Code / Cursor / vscode-server — same path as Cursor acp-sessions. */
export function getPermissionStorePath(): string {
  return path.join(os.homedir(), '.cursor', 'acp-permissions.json');
}

function normalizeStore(data: PermissionStoreData): PermissionStoreData {
  const approvedCommands = [...new Set((data.approvedCommands || []).filter(Boolean))];
  const approvedTools = [
    ...new Set((data.approvedTools || []).map(normalizeApprovedToolFingerprint).filter(Boolean)),
  ];
  return { approvedCommands, approvedTools };
}

export function readPermissionStore(): PermissionStoreData {
  const filePath = getPermissionStorePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_DATA };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PermissionStoreData>;
    return normalizeStore({
      approvedCommands: Array.isArray(parsed.approvedCommands) ? parsed.approvedCommands : [],
      approvedTools: Array.isArray(parsed.approvedTools) ? parsed.approvedTools : [],
    });
  } catch (e: unknown) {
    log(`Failed to read permission store ${filePath}: ${e instanceof Error ? e.message : e}`);
    return { ...DEFAULT_DATA };
  }
}

export function writePermissionStore(data: PermissionStoreData): void {
  const filePath = getPermissionStorePath();
  const normalized = normalizeStore(data);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  } catch (e: unknown) {
    log(`Failed to write permission store ${filePath}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Merge vscode settings + ~/.cursor file (union, normalized). */
export function mergePermissionLists(
  fromSettings: string[] | undefined,
  fromFile: string[] | undefined,
  normalizeToolFp: boolean,
): string[] {
  const out = new Set<string>();
  for (const src of [fromSettings, fromFile]) {
    if (!src) {continue;}
    for (const item of src) {
      if (!item) {continue;}
      out.add(normalizeToolFp ? normalizeApprovedToolFingerprint(item) : item);
    }
  }
  return Array.from(out);
}
