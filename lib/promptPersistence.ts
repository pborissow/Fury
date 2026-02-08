import * as fs from 'fs/promises';
import * as path from 'path';

export interface Prompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

class PromptPersistence {
  private storageDir = path.join(process.cwd(), '.claude-prompts');

  private async ensureStorageDir(): Promise<void> {
    try {
      await fs.access(this.storageDir);
    } catch {
      await fs.mkdir(this.storageDir, { recursive: true });
    }
  }

  private getPromptPath(promptId: string): string {
    return path.join(this.storageDir, `${promptId}.json`);
  }

  async savePrompt(prompt: Prompt): Promise<void> {
    await this.ensureStorageDir();
    const promptPath = this.getPromptPath(prompt.id);
    await fs.writeFile(promptPath, JSON.stringify(prompt, null, 2), 'utf-8');
  }

  async loadPrompt(promptId: string): Promise<Prompt | null> {
    try {
      const promptPath = this.getPromptPath(promptId);
      const content = await fs.readFile(promptPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  async loadAllPrompts(): Promise<Prompt[]> {
    try {
      await this.ensureStorageDir();
      const files = await fs.readdir(this.storageDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const prompts: Prompt[] = [];
      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(
            path.join(this.storageDir, file),
            'utf-8'
          );
          const prompt = JSON.parse(content);
          prompts.push(prompt);
        } catch (error) {
          console.error(`Error loading prompt ${file}:`, error);
        }
      }

      // Sort by updatedAt descending (most recent first)
      return prompts.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      console.error('Error loading prompts:', error);
      return [];
    }
  }

  async deletePrompt(promptId: string): Promise<void> {
    try {
      const promptPath = this.getPromptPath(promptId);
      await fs.unlink(promptPath);
    } catch (error) {
      console.error(`Error deleting prompt ${promptId}:`, error);
    }
  }

  async updatePrompt(promptId: string, updates: Partial<Prompt>): Promise<Prompt | null> {
    const existingPrompt = await this.loadPrompt(promptId);
    if (!existingPrompt) {
      return null;
    }

    const updatedPrompt: Prompt = {
      ...existingPrompt,
      ...updates,
      id: promptId, // Ensure ID doesn't change
      updatedAt: Date.now(),
    };

    await this.savePrompt(updatedPrompt);
    return updatedPrompt;
  }
}

export const promptPersistence = new PromptPersistence();
