import dotenv from 'dotenv';
dotenv.config();
import * as fsPromises from "fs/promises";
import copy from "rollup-plugin-copy";
import scss from "rollup-plugin-scss";
import { defineConfig, Plugin } from "vite";
import * as path from "path";
import * as os from "os";
import { id as moduleId } from "./src/module.json";

const moduleVersion = process.env.MODULE_VERSION;
const githubProject = process.env.GH_PROJECT;
const githubTag = process.env.GH_TAG;

// Parse comma-separated paths, trim whitespace, filter empties
const foundryVttDataPaths = (process.env.FOUNDRY_VTT_DATA_MODULES_PATH || "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);

if (foundryVttDataPaths.length === 0) {
  foundryVttDataPaths.push(path.join(
    os.homedir(),
    "AppData",
    "Local",
    "FoundryVTT",
    "Data",
    "modules"
  ));
}

console.log("VSCODE_INJECTION", process.env.VSCODE_INJECTION);

// Ensure the Foundry VTT modules directory exists
async function ensureDirectory(directoryPath) {
  try {
    await fsPromises.mkdir(directoryPath, { recursive: true });
  } catch (error) {
    console.error(`Error creating directory ${directoryPath}:`, error);
  }
}

// Create the module directories before starting the build
if (!process.env.CI) {
  for (const p of foundryVttDataPaths) {
    ensureDirectory(path.join(p, moduleId));
  }
}

export default defineConfig({
  build: {
    sourcemap: true,
    outDir: "dist",
    rollupOptions: {
      input: "src/ts/module.ts",
      output: {
        dir: process.env.CI ? "dist/scripts" : path.join(foundryVttDataPaths[0], moduleId, "scripts"),
        entryFileNames: "module.js",
        format: "es",
      },
    },
  },
  plugins: [
    updateModuleManifestPlugin(),
    scss({
      output: async function(styles) {
        // Write to all FoundryVTT paths for development
        if (!process.env.CI) {
          for (const p of foundryVttDataPaths) {
            const moduleDir = path.join(p, moduleId, "styles");
            await ensureDirectory(moduleDir);
            await fsPromises.writeFile(path.join(moduleDir, "style.css"), styles);
          }
        }
        // Always write to dist for CI
        await ensureDirectory("dist/styles");
        await fsPromises.writeFile("dist/styles/style.css", styles);
      },
      sourceMap: true,
      watch: ["src/styles/*.scss"],
    }),
    copy({
      targets: [
        // Development targets — generate for all paths
        ...(!process.env.CI ? foundryVttDataPaths.flatMap(p => [
          { src: "src/languages", dest: path.join(p, moduleId) },
          { src: "src/templates", dest: path.join(p, moduleId) }
        ]) : []),
        // CI/Production targets
        { src: "src/languages", dest: "dist" },
        { src: "src/templates", dest: "dist" }
      ],
      hook: "writeBundle",
    }),
    copyToAdditionalPathsPlugin(),
  ],
});

function copyToAdditionalPathsPlugin(): Plugin {
  return {
    name: "copy-to-additional-paths",
    async writeBundle(): Promise<void> {
      if (process.env.CI || foundryVttDataPaths.length <= 1) return;

      const primaryDir = path.join(foundryVttDataPaths[0], moduleId, "scripts");
      for (const p of foundryVttDataPaths.slice(1)) {
        const targetDir = path.join(p, moduleId, "scripts");
        await ensureDirectory(targetDir);
        // Copy all files from primary scripts dir to additional paths
        try {
          const files = await fsPromises.readdir(primaryDir);
          for (const file of files) {
            await fsPromises.copyFile(
              path.join(primaryDir, file),
              path.join(targetDir, file)
            );
          }
        } catch (error) {
          console.error(`Error copying scripts to ${targetDir}:`, error);
        }
      }
    },
  };
}

function updateModuleManifestPlugin(): Plugin {
  return {
    name: "update-module-manifest",
    async writeBundle(): Promise<void> {
      // Create directories in all FoundryVTT modules paths (for development)
      if (!process.env.CI) {
        for (const p of foundryVttDataPaths) {
          await ensureDirectory(path.join(p, moduleId));
        }
      }

      // Always create dist directory (for CI/production)
      await ensureDirectory("dist");

      const packageContents = JSON.parse(
        await fsPromises.readFile("./package.json", "utf-8")
      ) as Record<string, unknown>;
      const version = moduleVersion || (packageContents.version as string);
      const manifestContents: string = await fsPromises.readFile(
        "src/module.json",
        "utf-8"
      );
      const manifestJson = JSON.parse(manifestContents) as Record<
        string,
        unknown
      >;
      manifestJson["version"] = version;
      if (githubProject) {
        const baseUrl = `https://github.com/${githubProject}/releases`;
        manifestJson["manifest"] = `${baseUrl}/latest/download/module.json`;
        if (githubTag) {
          manifestJson[
            "download"
          ] = `${baseUrl}/download/${githubTag}/module.zip`;
        }
      }

      // Write updated manifest to all FoundryVTT modules paths (for development)
      if (!process.env.CI) {
        for (const p of foundryVttDataPaths) {
          await fsPromises.writeFile(
            path.join(p, moduleId, "module.json"),
            JSON.stringify(manifestJson, null, 4)
          );
        }
      }

      // Always write updated manifest to dist directory (for CI/production)
      await fsPromises.writeFile(
        "dist/module.json",
        JSON.stringify(manifestJson, null, 4)
      );
    },
  };
}
