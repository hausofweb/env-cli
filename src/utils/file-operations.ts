import path from "node:path";

import fs from "fs-extra";

/**
 * Safe file I/O operations with error handling
 */
export const FileOperations = {
  /**
   * Check if directory exists
   */
  dirExists: async (dirPath: string): Promise<boolean> => {
    try {
      const stats = await fs.stat(dirPath);

      return stats.isDirectory();
    } catch {
      return false;
    }
  },

  /**
   * Ensure directory exists (create if needed)
   */
  ensureDir: async (dirPath: string): Promise<void> => {
    try {
      await fs.ensureDir(dirPath);
    } catch (error) {
      throw new Error(`Failed to create directory: ${dirPath}\n${error}`, {
        cause: error,
      });
    }
  },

  /**
   * Check if file exists
   */
  fileExists: async (filePath: string): Promise<boolean> => {
    try {
      await fs.access(filePath);

      return true;
    } catch {
      return false;
    }
  },

  /**
   * List directory contents
   */
  listDir: async (dirPath: string): Promise<string[]> => {
    try {
      return await fs.readdir(dirPath);
    } catch (error) {
      throw new Error(`Failed to list directory: ${dirPath}\n${error}`, {
        cause: error,
      });
    }
  },
  /**
   * Read file content
   */
  readFile: async (filePath: string): Promise<string> => {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read file: ${filePath}\n${error}`, {
        cause: error,
      });
    }
  },

  /**
   * Remove file
   */
  removeFile: async (filePath: string): Promise<void> => {
    try {
      await fs.remove(filePath);
    } catch (error) {
      throw new Error(`Failed to remove file: ${filePath}\n${error}`, {
        cause: error,
      });
    }
  },

  /**
   * Write file content
   */
  writeFile: async (filePath: string, content: string): Promise<void> => {
    try {
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content, "utf-8");
    } catch (error) {
      throw new Error(`Failed to write file: ${filePath}\n${error}`, {
        cause: error,
      });
    }
  },
};
