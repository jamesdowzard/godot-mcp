import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, isAbsolute } from 'path';

/**
 * Pure-TypeScript reimplementation of Godot's Android export validator.
 *
 * Godot 4.x has a known limitation: `godot --headless --export-debug` prints
 * "Cannot export project with preset X due to configuration errors:" followed
 * by an empty list — the actual errors only render in the GUI Export dialog.
 * This validator inspects the same files Godot's C++ validator inspects and
 * reports the most common Android export failures without needing Godot
 * running at all.
 *
 * Covers the rules that hit us while bootstrapping vr-player:
 * - Android build template not installed
 * - Multiple XR vendor plugins enabled simultaneously
 * - ETC2/ASTC texture compression flag missing
 * - project.godot icon path missing on disk
 * - config.gradle openxrVendorsVersion mismatch with addon
 * - config.gradle NDK version not installed
 * - Package name contains hyphens
 */

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  fix?: string;
}

export interface ValidationResult {
  preset: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: {
    platform?: string;
    xr_plugins_enabled?: string[];
    package_name?: string;
    vendors_addon_version?: string;
    gradle_vendors_version?: string;
    gradle_ndk_version?: string;
    installed_ndk_versions?: string[];
  };
}

type IniSection = Record<string, string>;
type IniFile = Record<string, IniSection>;

function parseIni(text: string): IniFile {
  const out: IniFile = {};
  let section = '';
  out[section] = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[section][key] = value;
  }
  return out;
}

function unquote(s: string | undefined): string {
  if (s === undefined) return '';
  return s.replace(/^"(.*)"$/, '$1');
}

function isTruthy(v: string | undefined): boolean {
  return v === 'true' || v === 'True' || v === '1';
}

function resolveResPath(projectPath: string, resPath: string): string {
  // Godot paths like "res://icon.svg" → <projectPath>/icon.svg
  if (resPath.startsWith('res://')) return join(projectPath, resPath.slice('res://'.length));
  if (isAbsolute(resPath)) return resPath;
  return join(projectPath, resPath);
}

function listInstalledNdkVersions(): string[] {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    join(home, 'Library/Android/sdk/ndk'),
    join(home, 'Android/Sdk/ndk'),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir);
      return entries.filter((e) => /^\d+\./.test(e));
    } catch {
      /* ignore */
    }
  }
  return [];
}

function readVendorsAddonVersion(projectPath: string): string | undefined {
  // godotopenxrvendors ships a CHANGES.md with a top-level version heading.
  const changes = join(projectPath, 'addons/godotopenxrvendors/GodotOpenXRVendors_CHANGES.md');
  if (!existsSync(changes)) return undefined;
  try {
    const text = readFileSync(changes, 'utf8');
    const match = text.match(/^##\s*(\d+\.\d+\.\d+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Validate a single export preset. The preset name must match a `[preset.N]`
 * block's `name` field in export_presets.cfg.
 */
export function validateExportPreset(
  projectPath: string,
  presetName: string
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const info: ValidationResult['info'] = {};

  const presetsPath = join(projectPath, 'export_presets.cfg');
  if (!existsSync(presetsPath)) {
    return {
      preset: presetName,
      valid: false,
      errors: [
        {
          level: 'error',
          code: 'no_export_presets',
          message: `export_presets.cfg not found at ${presetsPath}`,
          file: presetsPath,
        },
      ],
      warnings: [],
      info,
    };
  }
  const presets = parseIni(readFileSync(presetsPath, 'utf8'));

  // Find the preset section by name.
  let presetSection: string | undefined;
  let optionsSection: string | undefined;
  for (const [section, values] of Object.entries(presets)) {
    if (/^preset\.\d+$/.test(section) && unquote(values.name) === presetName) {
      presetSection = section;
      optionsSection = `${section}.options`;
      break;
    }
  }
  if (!presetSection || !optionsSection || !presets[optionsSection]) {
    return {
      preset: presetName,
      valid: false,
      errors: [
        {
          level: 'error',
          code: 'preset_not_found',
          message: `Preset '${presetName}' not found in export_presets.cfg`,
          file: presetsPath,
        },
      ],
      warnings: [],
      info,
    };
  }

  const presetFields = presets[presetSection];
  const opts = presets[optionsSection];
  const platform = unquote(presetFields.platform);
  info.platform = platform;

  if (platform !== 'Android') {
    warnings.push({
      level: 'warning',
      code: 'non_android_preset',
      message: `Preset '${presetName}' targets '${platform}' — only Android validation is implemented.`,
    });
    return { preset: presetName, valid: errors.length === 0, errors, warnings, info };
  }

  const packageName = unquote(opts['package/unique_name']);
  info.package_name = packageName;
  if (packageName.includes('-')) {
    errors.push({
      level: 'error',
      code: 'package_hyphen',
      message: `Package name '${packageName}' contains a hyphen — Android disallows hyphens in package segments.`,
      file: presetsPath,
      fix: `Rename to e.g. '${packageName.replace(/-/g, '')}' in package/unique_name.`,
    });
  }

  // XR vendor plugins — only one can be enabled at a time.
  const xrKeys = [
    'xr_features/enable_khronos_plugin',
    'xr_features/enable_meta_plugin',
    'xr_features/enable_pico_plugin',
    'xr_features/enable_lynx_plugin',
    'xr_features/enable_magicleap_plugin',
    'xr_features/enable_androidxr_plugin',
  ];
  const enabled = xrKeys.filter((k) => isTruthy(opts[k])).map((k) => k.split('/')[1]);
  info.xr_plugins_enabled = enabled;
  if (enabled.length > 1) {
    errors.push({
      level: 'error',
      code: 'multiple_xr_plugins',
      message: `Multiple XR vendor plugins enabled: ${enabled.join(', ')}. Only one is permitted.`,
      file: presetsPath,
      fix: 'Set all but your target vendor plugin to false (e.g. keep only enable_meta_plugin=true for Quest 3).',
    });
  }

  const metaEnabled = isTruthy(opts['xr_features/enable_meta_plugin']);
  const usesGradle = isTruthy(opts['gradle_build/use_gradle_build']);

  // Android build template installation marker.
  if (usesGradle) {
    const buildGradle = join(projectPath, 'android/build/build.gradle');
    const buildVersionFile = join(projectPath, 'android/.build_version');
    if (!existsSync(buildGradle) || !existsSync(buildVersionFile)) {
      errors.push({
        level: 'error',
        code: 'android_template_missing',
        message: 'Android build template not installed in the project.',
        fix: 'Run: godot --headless --path <project> --install-android-build-template, then unzip android_source.zip into android/build/.',
      });
    }

    // config.gradle: vendors and NDK versions.
    const configGradle = join(projectPath, 'android/build/config.gradle');
    if (existsSync(configGradle)) {
      const gradleText = readFileSync(configGradle, 'utf8');

      const ndkMatch = gradleText.match(/ndkVersion\s*:\s*'([^']+)'/);
      if (ndkMatch) {
        info.gradle_ndk_version = ndkMatch[1];
        const installed = listInstalledNdkVersions();
        info.installed_ndk_versions = installed;
        if (installed.length > 0 && !installed.includes(ndkMatch[1])) {
          errors.push({
            level: 'error',
            code: 'ndk_not_installed',
            message: `config.gradle requires NDK ${ndkMatch[1]} but it is not installed. Installed: ${installed.join(', ')}.`,
            file: configGradle,
            fix: `Install via Android Studio SDK Manager, or edit config.gradle ndkVersion to one of: ${installed.join(', ')}.`,
          });
        }
      }

      const vendorsMatch = gradleText.match(/openxrVendorsVersion\s*:\s*'([^']+)'/);
      if (vendorsMatch) {
        info.gradle_vendors_version = vendorsMatch[1];
        const addonVersion = readVendorsAddonVersion(projectPath);
        if (addonVersion) {
          info.vendors_addon_version = addonVersion;
          if (!vendorsMatch[1].startsWith(addonVersion)) {
            errors.push({
              level: 'error',
              code: 'vendors_version_mismatch',
              message: `config.gradle openxrVendorsVersion='${vendorsMatch[1]}' but godotopenxrvendors addon is ${addonVersion}. Gradle will pull the wrong AAR and libgodotopenxrvendors.so will be missing from the APK.`,
              file: configGradle,
              fix: `Edit config.gradle: openxrVendorsVersion: '${addonVersion}-stable'`,
            });
          }
        }
      }
    }
  }

  // Project-level flags (project.godot).
  const projectGodot = join(projectPath, 'project.godot');
  if (existsSync(projectGodot)) {
    const pg = parseIni(readFileSync(projectGodot, 'utf8'));

    // ETC2/ASTC required for Android XR targets.
    const etc2 = isTruthy(pg.rendering?.['textures/vram_compression/import_etc2_astc']);
    if (metaEnabled && !etc2) {
      errors.push({
        level: 'error',
        code: 'etc2_astc_required',
        message: `Target platform requires 'ETC2/ASTC' texture compression. Enable 'Import ETC2 ASTC' in project settings.`,
        file: projectGodot,
        fix: `Add under [rendering]:\n    textures/vram_compression/import_etc2_astc=true`,
      });
    }

    // Icon path existence.
    const iconPath = unquote(pg.application?.['config/icon']);
    if (iconPath) {
      const iconAbs = resolveResPath(projectPath, iconPath);
      if (!existsSync(iconAbs)) {
        errors.push({
          level: 'error',
          code: 'icon_missing',
          message: `Project icon '${iconPath}' referenced in project.godot does not exist on disk.`,
          file: projectGodot,
          fix: `Create the file at ${iconAbs}, or update application/config/icon to point at an existing path.`,
        });
      }
    }
  }

  return { preset: presetName, valid: errors.length === 0, errors, warnings, info };
}
