import fs from 'fs/promises';
import path from 'path';

interface Workflow {
  id: string;
  name: string;
  data: any;
  createdAt: number;
  updatedAt: number;
}

class WorkflowPersistence {
  private storageDir: string;

  constructor() {
    // Store workflows in .claude-workflows directory
    this.storageDir = path.join(process.cwd(), '.claude-workflows');
  }

  /**
   * Initialize storage directory
   */
  private async ensureStorageDir(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create workflow storage directory:', error);
      throw error;
    }
  }

  /**
   * Get file path for a workflow
   */
  private getWorkflowPath(workflowId: string): string {
    return path.join(this.storageDir, `${workflowId}.json`);
  }

  /**
   * Generate a unique workflow ID
   */
  private generateId(): string {
    return `workflow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Save a workflow
   */
  async saveWorkflow(name: string, data: any, id?: string): Promise<Workflow> {
    try {
      await this.ensureStorageDir();

      const workflowId = id || this.generateId();
      const now = Date.now();

      const workflow: Workflow = {
        id: workflowId,
        name,
        data,
        createdAt: id ? (await this.loadWorkflow(id))?.createdAt || now : now,
        updatedAt: now,
      };

      const filePath = this.getWorkflowPath(workflowId);
      await fs.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');

      console.log(`[WorkflowPersistence] Saved workflow ${workflowId}: ${name}`);
      return workflow;
    } catch (error) {
      console.error(`[WorkflowPersistence] Failed to save workflow:`, error);
      throw error;
    }
  }

  /**
   * Load a workflow by ID
   */
  async loadWorkflow(workflowId: string): Promise<Workflow | null> {
    try {
      const filePath = this.getWorkflowPath(workflowId);
      const content = await fs.readFile(filePath, 'utf-8');
      const workflow: Workflow = JSON.parse(content);

      console.log(`[WorkflowPersistence] Loaded workflow ${workflowId}`);
      return workflow;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(`[WorkflowPersistence] Workflow ${workflowId} not found`);
        return null;
      }
      console.error(`[WorkflowPersistence] Failed to load workflow ${workflowId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a workflow
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    try {
      const filePath = this.getWorkflowPath(workflowId);
      await fs.unlink(filePath);
      console.log(`[WorkflowPersistence] Deleted workflow ${workflowId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      console.error(`[WorkflowPersistence] Failed to delete workflow ${workflowId}:`, error);
      throw error;
    }
  }

  /**
   * List all workflows
   */
  async listWorkflows(): Promise<Workflow[]> {
    try {
      await this.ensureStorageDir();
      const files = await fs.readdir(this.storageDir);
      const workflows: Workflow[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(this.storageDir, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const workflow: Workflow = JSON.parse(content);
            workflows.push(workflow);
          } catch (error) {
            console.error(`[WorkflowPersistence] Failed to read workflow file ${file}:`, error);
          }
        }
      }

      // Sort by most recent first
      workflows.sort((a, b) => b.updatedAt - a.updatedAt);
      return workflows;
    } catch (error) {
      console.error('[WorkflowPersistence] Failed to list workflows:', error);
      return [];
    }
  }

  /**
   * Update workflow name
   */
  async updateWorkflowName(workflowId: string, name: string): Promise<Workflow | null> {
    try {
      const workflow = await this.loadWorkflow(workflowId);
      if (!workflow) {
        return null;
      }

      workflow.name = name;
      workflow.updatedAt = Date.now();

      const filePath = this.getWorkflowPath(workflowId);
      await fs.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');

      console.log(`[WorkflowPersistence] Updated workflow name ${workflowId}: ${name}`);
      return workflow;
    } catch (error) {
      console.error(`[WorkflowPersistence] Failed to update workflow name:`, error);
      throw error;
    }
  }

  /**
   * Update workflow data (for auto-save)
   */
  async updateWorkflowData(workflowId: string, data: any): Promise<Workflow | null> {
    try {
      const workflow = await this.loadWorkflow(workflowId);
      if (!workflow) {
        return null;
      }

      workflow.data = data;
      workflow.updatedAt = Date.now();

      const filePath = this.getWorkflowPath(workflowId);
      await fs.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');

      console.log(`[WorkflowPersistence] Updated workflow data ${workflowId}`);
      return workflow;
    } catch (error) {
      console.error(`[WorkflowPersistence] Failed to update workflow data:`, error);
      throw error;
    }
  }
}

// Singleton instance
export const workflowPersistence = new WorkflowPersistence();
export type { Workflow };
