import fs from 'node:fs';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export interface BackgroundAsset {
  id: string;
  name: string;
  filePath: string;
  url: string;
}

export interface StyleDescriptor {
  id: string;
  label: string;
  actionDir: string;
  backgroundsDir?: string;
  backgrounds: BackgroundAsset[];
  selectedBackgroundName?: string;
}

export interface RoleDescriptor {
  id: string;
  label: string;
  stateDir: string;
  roleRoot?: string;
  styles: StyleDescriptor[];
}

export interface ActiveProfileSelection {
  roleId: string;
  styleId: string;
}

export interface ActiveProfileContext {
  roleId: string;
  roleLabel: string;
  styleId: string;
  styleLabel: string;
  stateDir: string;
  actionDir: string;
  backgrounds: BackgroundAsset[];
  selectedBackgroundName?: string;
}

export interface ProfileCatalogResponse {
  activeRoleId: string;
  activeStyleId: string;
  activeRoleLabel: string;
  activeStyleLabel: string;
  selectedBackgroundName?: string;
  roles: Array<{
    id: string;
    label: string;
    styles: Array<{
      id: string;
      label: string;
      backgroundCount: number;
    }>;
  }>;
  backgrounds: BackgroundAsset[];
}

interface RoleCatalogIndexEntry {
  roleDir: string;
}

interface RoleDirectoryStyleConfig {
  id: string;
  label: string;
  actionDir?: string;
  backgroundsDir?: string;
  selectedBackgroundName?: string;
}

interface RoleDirectoryConfig {
  id: string;
  label: string;
  stateDir?: string;
  styles?: RoleDirectoryStyleConfig[];
}

interface RoleCatalogFile {
  roles: RoleCatalogIndexEntry[];
}

function resolveCatalogPath(rootDir: string): string {
  return path.join(rootDir, 'roles', 'roles.json');
}

function resolveAbsolutePath(rootDir: string, maybeRelativePath?: string): string | undefined {
  if (!maybeRelativePath || !maybeRelativePath.trim()) {
    return undefined;
  }
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(rootDir, maybeRelativePath);
}

function listDirs(parentDir: string): string[] {
  if (!fs.existsSync(parentDir)) {
    return [];
  }
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function toBackgroundAssetUrl(filePath: string): string {
  return `cda-resource://background?path=${encodeURIComponent(filePath)}`;
}

function listBackgrounds(backgroundsDir?: string): BackgroundAsset[] {
  if (!backgroundsDir || !fs.existsSync(backgroundsDir)) {
    return [];
  }
  return fs
    .readdirSync(backgroundsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry, index) => {
      const filePath = path.join(backgroundsDir, entry.name);
      return {
        id: `${index}-${entry.name}`,
        name: entry.name,
        filePath,
        url: toBackgroundAssetUrl(filePath),
      };
    });
}

function normalizeSelectedBackgroundName(backgrounds: BackgroundAsset[], selectedBackgroundName?: string): string | undefined {
  const selectedName = String(selectedBackgroundName ?? '').trim();
  if (!selectedName) {
    return undefined;
  }
  return backgrounds.some((item) => item.name === selectedName) ? selectedName : undefined;
}

function makeStyleDescriptor(
  styleId: string,
  label: string,
  actionDir: string,
  backgroundsDir?: string,
  selectedBackgroundName?: string
): StyleDescriptor {
  const backgrounds = listBackgrounds(backgroundsDir);
  return {
    id: styleId,
    label,
    actionDir,
    backgroundsDir,
    backgrounds,
    selectedBackgroundName: normalizeSelectedBackgroundName(backgrounds, selectedBackgroundName),
  };
}

function readRoleConfig(roleRoot: string): RoleDirectoryConfig | null {
  const configPath = path.join(roleRoot, 'role.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as RoleDirectoryConfig;
  } catch {
    return null;
  }
}

function buildRoleFromDirectory(rootDir: string, entry: RoleCatalogIndexEntry): RoleDescriptor | null {
  const roleRoot = resolveAbsolutePath(rootDir, entry.roleDir);
  if (!roleRoot || !fs.existsSync(roleRoot)) {
    return null;
  }
  const roleConfig = readRoleConfig(roleRoot);
  const roleId = String(roleConfig?.id ?? '').trim();
  const roleLabel = String(roleConfig?.label ?? '').trim();
  const stateDir = resolveAbsolutePath(roleRoot, roleConfig?.stateDir ?? 'state');
  if (!roleId || !roleLabel || !stateDir || !fs.existsSync(stateDir)) {
    return null;
  }
  const stylesFromConfig = Array.isArray(roleConfig?.styles) ? roleConfig.styles : [];
  const styles: StyleDescriptor[] = [];
  for (const styleConfig of stylesFromConfig) {
    const styleId = String(styleConfig.id ?? '').trim();
    const styleLabel = String(styleConfig.label ?? '').trim();
    if (!styleId || !styleLabel) {
      continue;
    }
    const actionDir =
      resolveAbsolutePath(roleRoot, styleConfig.actionDir) ??
      path.join(roleRoot, 'action', styleId);
    const backgroundsDir =
      resolveAbsolutePath(roleRoot, styleConfig.backgroundsDir) ??
      path.join(roleRoot, 'backgrounds', styleId);
    styles.push(
      makeStyleDescriptor(styleId, styleLabel, actionDir, backgroundsDir, styleConfig.selectedBackgroundName)
    );
  }
  if (styles.length === 0) {
    styles.push(
      makeStyleDescriptor(
        'default',
        'Default',
        path.join(roleRoot, 'action', 'default'),
        path.join(roleRoot, 'backgrounds', 'default')
      )
    );
  }
  return {
    id: roleId,
    label: roleLabel,
    stateDir,
    roleRoot,
    styles,
  };
}

export function discoverRoles(rootDir: string): RoleDescriptor[] {
  const catalogPath = resolveCatalogPath(rootDir);
  if (!fs.existsSync(catalogPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(catalogPath, 'utf-8');
    const parsed = JSON.parse(raw) as RoleCatalogFile;
    const roles = Array.isArray(parsed.roles) ? parsed.roles : [];
    return roles
      .map((role) => buildRoleFromDirectory(rootDir, role))
      .filter((role): role is RoleDescriptor => Boolean(role))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function readActiveSelection(selectionPath: string): Promise<ActiveProfileSelection | null> {
  try {
    const raw = await readFile(selectionPath, 'utf-8');
    const parsed = JSON.parse(raw) as ActiveProfileSelection;
    if (typeof parsed.roleId === 'string' && typeof parsed.styleId === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeActiveSelection(selectionPath: string, selection: ActiveProfileSelection): Promise<void> {
  await mkdir(path.dirname(selectionPath), { recursive: true });
  await writeFile(selectionPath, JSON.stringify(selection, null, 2), 'utf-8');
}

export function resolveActiveContext(
  roles: RoleDescriptor[],
  requested?: Partial<ActiveProfileSelection> | null
): ActiveProfileContext | null {
  if (roles.length === 0) {
    return null;
  }
  const role =
    roles.find((item) => item.id === requested?.roleId) ??
    roles.find((item) => item.id === 'default') ??
    roles[0];
  const style =
    role.styles.find((item) => item.id === requested?.styleId) ??
    role.styles[0];
  return {
    roleId: role.id,
    roleLabel: role.label,
    styleId: style.id,
    styleLabel: style.label,
    stateDir: role.stateDir,
    actionDir: style.actionDir,
    backgrounds: style.backgrounds,
    selectedBackgroundName: style.selectedBackgroundName,
  };
}

export function toCatalogResponse(roles: RoleDescriptor[], active: ActiveProfileContext): ProfileCatalogResponse {
  return {
    activeRoleId: active.roleId,
    activeStyleId: active.styleId,
    activeRoleLabel: active.roleLabel,
    activeStyleLabel: active.styleLabel,
    selectedBackgroundName: active.selectedBackgroundName,
    roles: roles.map((role) => ({
      id: role.id,
      label: role.label,
      styles: role.styles.map((style) => ({
        id: style.id,
        label: style.label,
        backgroundCount: style.backgrounds.length,
      })),
    })),
    backgrounds: active.backgrounds,
  };
}

async function writeRoleConfig(roleRoot: string, roleConfig: RoleDirectoryConfig): Promise<void> {
  const configPath = path.join(roleRoot, 'role.json');
  await writeFile(configPath, JSON.stringify(roleConfig, null, 2), 'utf-8');
}

export async function saveSelectedBackgroundName(
  rootDir: string,
  roleId: string,
  styleId: string,
  selectedBackgroundName?: string
): Promise<void> {
  const roles = discoverRoles(rootDir);
  const role = roles.find((item) => item.id === roleId);
  if (!role?.roleRoot) {
    throw new Error('角色不存在');
  }
  const style = role.styles.find((item) => item.id === styleId);
  if (!style) {
    throw new Error('风格不存在');
  }

  const normalizedSelectedBackgroundName = normalizeSelectedBackgroundName(style.backgrounds, selectedBackgroundName);
  const requestedSelectedBackgroundName = String(selectedBackgroundName ?? '').trim();
  if (requestedSelectedBackgroundName && !normalizedSelectedBackgroundName) {
    throw new Error('背景图片不存在');
  }

  const roleConfig = readRoleConfig(role.roleRoot);
  if (!roleConfig) {
    throw new Error('角色配置不存在');
  }

  const stylesFromConfig = Array.isArray(roleConfig.styles) ? roleConfig.styles : [];
  const targetStyle = stylesFromConfig.find((item) => String(item.id ?? '').trim() === styleId);
  if (!targetStyle) {
    throw new Error('风格配置不存在');
  }

  if (normalizedSelectedBackgroundName) {
    targetStyle.selectedBackgroundName = normalizedSelectedBackgroundName;
  } else {
    delete targetStyle.selectedBackgroundName;
  }
  roleConfig.styles = stylesFromConfig;
  await writeRoleConfig(role.roleRoot, roleConfig);
}
