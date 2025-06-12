import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("fileSystemRouter");

router.addRoute({
  actionType: "get-file-system",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received get file system request:`, data);

    try {
      const path = data.path || "";
      const source = data.source || "data";
      const recursive = !!data.recursive;

      const result = await FilePicker.browse(source, path);

      const dirs = Array.isArray(result.dirs) ? result.dirs.map((dir: string) => ({
        name: dir.split('/').pop() || dir,
        path: dir,
        type: 'directory'
      })) : [];

      const files = Array.isArray(result.files) ? result.files.map((file: string) => ({
        name: file.split('/').pop() || file,
        path: file,
        type: 'file'
      })) : [];

      let subdirs: Array<{name: string, path: string, type: string}> = [];
      if (recursive && dirs.length > 0) {
        for (const dir of dirs) {
          try {
            const subResult = await FilePicker.browse(source, dir.path);

            const subDirs = Array.isArray(subResult.dirs) ? subResult.dirs.map((subdir: string) => ({
              name: subdir.split('/').pop() || subdir,
              path: subdir,
              type: 'directory'
            })) : [];

            const subFiles = Array.isArray(subResult.files) ? subResult.files.map((file: string) => ({
              name: file.split('/').pop() || file,
              path: file,
              type: 'file'
            })) : [];

            subdirs = subdirs.concat(subDirs, subFiles);

            if (recursive === true && subDirs.length > 0 && dir.path.split('/').length < 3) {
              for (const subDir of subDirs) {
                try {
                  const deepResult = await FilePicker.browse(source, subDir.path);

                  const deepDirs = Array.isArray(deepResult.dirs) ? deepResult.dirs.map((deepdir: string) => ({
                    name: deepdir.split('/').pop() || deepdir,
                    path: deepdir,
                    type: 'directory'
                  })) : [];

                  const deepFiles = Array.isArray(deepResult.files) ? deepResult.files.map((file: string) => ({
                    name: file.split('/').pop() || file,
                    path: file,
                    type: 'file'
                  })) : [];

                  subdirs = subdirs.concat(deepDirs, deepFiles);
                } catch (deepError) {
                  ModuleLogger.error(`Error processing deep subdirectory ${subDir.path}:`, deepError);
                }
              }
            }
          } catch (error) {
            ModuleLogger.error(`Error processing subdirectory ${dir.path}:`, error);
          }
        }
      }

      const results = [...dirs, ...files];
      if (recursive) {
        results.push(...subdirs);
      }

      socketManager?.send({
        type: "file-system-result",
        requestId: data.requestId,
        success: true,
        path,
        source,
        results,
        recursive
      });
    } catch (error) {
      ModuleLogger.error(`Error getting file system:`, error);
      socketManager?.send({
        type: "file-system-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "upload-file",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received upload file request:`, data);

    try {
      const { path, filename, source, fileData, mimeType, binaryData, overwrite } = data;

      if (!path || !filename) {
        throw new Error("Missing required parameters (path, filename)");
      }

      let file;

      if (binaryData) {
        const bytes = new Uint8Array(binaryData);
        const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
        file = new File([blob], filename, { type: mimeType || 'application/octet-stream' });
      } else if (fileData) {
        const base64Data = fileData.split(',')[1];
        const binaryData = atob(base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
        file = new File([blob], filename, { type: mimeType || 'application/octet-stream' });
      } else {
        throw new Error("Missing file data (either binaryData or fileData is required)");
      }

      const uploadSource = source || "data";

      try {
        const directories = path.split('/');
        let currentPath = '';

        for (const directory of directories) {
          currentPath = currentPath ? `${currentPath}/${directory}` : directory;
          try {
            await FilePicker.createDirectory(uploadSource, currentPath);
          } catch (createDirError) {
            if (!(createDirError as any).message.includes("already exists")) {
              ModuleLogger.error(`Error creating directory:`, createDirError);
              throw new Error(`Could not create directory: ${(createDirError as Error).message}`);
            }
          }
        }
      } catch (createDirError) {
        ModuleLogger.error(`Error creating directory:`, createDirError);
        throw new Error(`Could not create directory: ${(createDirError as Error).message}`);
      }

      let existingFile = null;
      try {
        const filePath = path + '/' + filename;
        existingFile = await FilePicker.browse(uploadSource, filePath);
      } catch (e) {
        // File does not exist, which is fine
      }

      if (existingFile && !overwrite) {
        throw new Error("File already exists. Set overwrite to true to replace it.");
      }

      const result = await FilePicker.upload(uploadSource, path, file);

      socketManager?.send({
        type: "upload-file-result",
        requestId: data.requestId,
        success: true,
        path: result && typeof result === 'object' && 'path' in result ? result.path : path + '/' + filename
      });
    } catch (error) {
      ModuleLogger.error(`Error uploading file:`, error);
      socketManager?.send({
        type: "upload-file-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "download-file",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received download file request:`, data);

    try {
      const { path } = data;

      if (!path) {
        throw new Error("Missing required parameter (path)");
      }

      const response = await fetch(path.startsWith('http') ? path : foundry.utils.getRoute(path));

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const reader = new FileReader();
      const fileData = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      socketManager?.send({
        type: "download-file-result",
        requestId: data.requestId,
        success: true,
        path,
        fileData,
        filename: path.split('/').pop() || 'file',
        mimeType: blob.type
      });
    } catch (error) {
      ModuleLogger.error(`Error downloading file:`, error);
      socketManager?.send({
        type: "download-file-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});
