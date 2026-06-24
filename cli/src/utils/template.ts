import { readFile, mkdir, writeFile, cp, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// After bun build: dist/index.js -> ../assets = cli/assets ✓
const ASSETS_DIR = join(__dirname, '..', 'assets');

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  // Path (relative to the install target) of the MCP config file to write/merge.
  configPath: string;
  // Key under "mcpServers" to register the server as.
  serverKey: string;
  server: McpServerConfig;
}

export interface PlatformConfig {
  platform: string;
  displayName: string;
  installType: 'full' | 'reference';
  folderStructure: {
    root: string;
    skillPath: string;
    filename: string;
  };
  scriptPath: string;
  frontmatter: Record<string, string> | null;
  sections: {
    quickReference: boolean;
  };
  mcp?: McpConfig;
  title: string;
  description: string;
  skillOrWorkflow: string;
}

// Map AIType to platform config file name
const AI_TO_PLATFORM: Record<string, string> = {
  claude: 'claude',
  cursor: 'cursor',
  windsurf: 'windsurf',
  antigravity: 'agent',
  copilot: 'copilot',
  kiro: 'kiro',
  opencode: 'opencode',
  roocode: 'roocode',
  codex: 'codex',
  qoder: 'qoder',
  gemini: 'gemini',
  trae: 'trae',
  continue: 'continue',
  codebuddy: 'codebuddy',
  droid: 'droid',
  kilocode: 'kilocode',
  warp: 'warp',
  augment: 'augment',
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load platform configuration from JSON file
 */
export async function loadPlatformConfig(aiType: string): Promise<PlatformConfig> {
  const platformName = AI_TO_PLATFORM[aiType];
  if (!platformName) {
    throw new Error(`Unknown AI type: ${aiType}`);
  }

  const configPath = join(ASSETS_DIR, 'templates', 'platforms', `${platformName}.json`);
  const content = await readFile(configPath, 'utf-8');
  return JSON.parse(content) as PlatformConfig;
}

/**
 * Load all available platform configs
 */
export async function loadAllPlatformConfigs(): Promise<Map<string, PlatformConfig>> {
  const configs = new Map<string, PlatformConfig>();

  for (const [aiType, platformName] of Object.entries(AI_TO_PLATFORM)) {
    try {
      const config = await loadPlatformConfig(aiType);
      configs.set(aiType, config);
    } catch {
      // Skip if config doesn't exist
    }
  }

  return configs;
}

/**
 * Load a template file
 */
async function loadTemplate(templateName: string): Promise<string> {
  const templatePath = join(ASSETS_DIR, 'templates', templateName);
  return readFile(templatePath, 'utf-8');
}

/**
 * Render frontmatter section
 */
function renderFrontmatter(frontmatter: Record<string, string> | null): string {
  if (!frontmatter) return '';

  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    // Quote values that contain special characters
    if (value.includes(':') || value.includes('"') || value.includes('\n')) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Render skill file content from template
 * When isGlobal=true, rewrites script paths to use ~/{root}/ prefix
 */
export async function renderSkillFile(config: PlatformConfig, isGlobal = false): Promise<string> {
  // Load base template
  let content = await loadTemplate('base/skill-content.md');

  // Load quick reference if needed
  let quickReferenceContent = '';
  if (config.sections.quickReference) {
    quickReferenceContent = await loadTemplate('base/quick-reference.md');
  }

  // Build the final content
  const frontmatter = renderFrontmatter(config.frontmatter);

  // Replace placeholders
  // Add newline before quick reference content if it exists
  const quickRefWithNewline = quickReferenceContent ? '\n' + quickReferenceContent : '';

  content = content
    .replace(/\{\{TITLE\}\}/g, config.title)
    .replace(/\{\{DESCRIPTION\}\}/g, config.description)
    .replace(/\{\{SCRIPT_PATH\}\}/g, config.scriptPath)
    .replace(/\{\{SKILL_OR_WORKFLOW\}\}/g, config.skillOrWorkflow)
    .replace(/\{\{QUICK_REFERENCE\}\}/g, quickRefWithNewline);

  // For global install, rewrite relative script paths to absolute ~/root/ paths
  if (isGlobal) {
    const globalPrefix = `~/${config.folderStructure.root}/`;
    content = content.replace(
      /python3 skills\//g,
      `python3 ${globalPrefix}skills/`
    );
  }

  return frontmatter + content;
}

/**
 * Copy data and scripts to target directory
 */
async function copyDataAndScripts(targetSkillDir: string): Promise<void> {
  const dataSource = join(ASSETS_DIR, 'data');
  const scriptsSource = join(ASSETS_DIR, 'scripts');

  const dataTarget = join(targetSkillDir, 'data');
  const scriptsTarget = join(targetSkillDir, 'scripts');

  // Copy data
  if (await exists(dataSource)) {
    await mkdir(dataTarget, { recursive: true });
    await cp(dataSource, dataTarget, { recursive: true });
  }

  // Copy scripts
  if (await exists(scriptsSource)) {
    await mkdir(scriptsTarget, { recursive: true });
    await cp(scriptsSource, scriptsTarget, { recursive: true });
  }
}

/**
 * Write or merge the 21st.dev Magic MCP server into the platform's MCP config file.
 *
 * - Creates the config file (and parent dirs) if it does not exist.
 * - Merges into an existing `mcpServers` map without clobbering other servers.
 * - Never overwrites an entry the user already defined under the same key.
 *
 * Returns the relative config path if written/updated, or null if skipped.
 */
async function writeMcpConfig(baseDir: string, mcp: McpConfig): Promise<string | null> {
  const targetPath = join(baseDir, mcp.configPath);

  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (await exists(targetPath)) {
    try {
      existing = JSON.parse(await readFile(targetPath, 'utf-8'));
    } catch {
      // Malformed config — don't risk corrupting it, leave it for the user.
      console.log(`  Skipped MCP setup: ${mcp.configPath} exists but is not valid JSON`);
      return null;
    }
  }

  const servers = (existing.mcpServers ??= {});
  if (Object.prototype.hasOwnProperty.call(servers, mcp.serverKey)) {
    // Respect an existing user-defined server with the same key.
    return null;
  }

  servers[mcp.serverKey] = mcp.server;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  return mcp.configPath;
}

/**
 * Generate platform files for a specific AI type
 * All platforms use self-contained installation with data and scripts
 * When isGlobal=true, installs to ~/home directory with absolute script paths
 */
export async function generatePlatformFiles(
  targetDir: string,
  aiType: string,
  isGlobal = false,
  force = false
): Promise<string[]> {
  const config = await loadPlatformConfig(aiType);
  const createdFolders: string[] = [];

  // For global install, target the user's home directory
  const effectiveDir = isGlobal ? homedir() : targetDir;

  // Determine full skill directory path
  const skillDir = join(
    effectiveDir,
    config.folderStructure.root,
    config.folderStructure.skillPath
  );

  // Create directory structure
  await mkdir(skillDir, { recursive: true });

  // Render and write skill file (pass isGlobal to adjust paths)
  const skillContent = await renderSkillFile(config, isGlobal);
  const skillFilePath = join(skillDir, config.folderStructure.filename);

  const fileAlreadyExists = await exists(skillFilePath);
  if (fileAlreadyExists && !force) {
    console.log(`  Skipped (already exists): ${skillFilePath} — use --force to overwrite`);
    return [];
  }

  await writeFile(skillFilePath, skillContent, 'utf-8');
  createdFolders.push(config.folderStructure.root);

  // Copy data and scripts into the skill directory (self-contained)
  await copyDataAndScripts(skillDir);

  // Wire up the 21st.dev Magic MCP server at the install root (project or home).
  if (config.mcp) {
    const mcpPath = await writeMcpConfig(effectiveDir, config.mcp);
    if (mcpPath) {
      createdFolders.push(mcpPath);
    }
  }

  return createdFolders;
}

/**
 * Generate files for all AI types
 */
export async function generateAllPlatformFiles(targetDir: string, isGlobal = false, force = false): Promise<string[]> {
  const allFolders = new Set<string>();

  for (const aiType of Object.keys(AI_TO_PLATFORM)) {
    try {
      const folders = await generatePlatformFiles(targetDir, aiType, isGlobal, force);
      folders.forEach(f => allFolders.add(f));
    } catch {
      // Skip if generation fails for a platform
    }
  }

  return Array.from(allFolders);
}

/**
 * Get list of supported AI types
 */
export function getSupportedAITypes(): string[] {
  return Object.keys(AI_TO_PLATFORM);
}
