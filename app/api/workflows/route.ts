import { NextResponse } from 'next/server';
import { workflowPersistence } from '@/lib/workflowPersistence';

// GET - List all workflows or get a single workflow by ID
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      // Get single workflow
      const workflow = await workflowPersistence.loadWorkflow(id);
      if (!workflow) {
        return NextResponse.json(
          { error: 'Workflow not found' },
          { status: 404 }
        );
      }
      return NextResponse.json({ workflow });
    } else {
      // List all workflows
      const workflows = await workflowPersistence.listWorkflows();
      return NextResponse.json({ workflows });
    }
  } catch (error) {
    console.error('Failed to get workflows:', error);
    return NextResponse.json(
      { error: 'Failed to get workflows' },
      { status: 500 }
    );
  }
}

// POST - Create a new workflow
export async function POST(request: Request) {
  try {
    const { name, data } = await request.json();

    if (!name || !data) {
      return NextResponse.json(
        { error: 'Name and data are required' },
        { status: 400 }
      );
    }

    const workflow = await workflowPersistence.saveWorkflow(name, data);
    return NextResponse.json({ workflow });
  } catch (error) {
    console.error('Failed to create workflow:', error);
    return NextResponse.json(
      { error: 'Failed to create workflow' },
      { status: 500 }
    );
  }
}

// PUT - Update workflow name
export async function PUT(request: Request) {
  try {
    const { id, name } = await request.json();

    if (!id || !name) {
      return NextResponse.json(
        { error: 'ID and name are required' },
        { status: 400 }
      );
    }

    const workflow = await workflowPersistence.updateWorkflowName(id, name);

    if (!workflow) {
      return NextResponse.json(
        { error: 'Workflow not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ workflow });
  } catch (error) {
    console.error('Failed to update workflow:', error);
    return NextResponse.json(
      { error: 'Failed to update workflow' },
      { status: 500 }
    );
  }
}

// PATCH - Update workflow data (for auto-save)
export async function PATCH(request: Request) {
  try {
    const { id, data } = await request.json();

    if (!id || !data) {
      return NextResponse.json(
        { error: 'ID and data are required' },
        { status: 400 }
      );
    }

    const workflow = await workflowPersistence.updateWorkflowData(id, data);

    if (!workflow) {
      return NextResponse.json(
        { error: 'Workflow not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ workflow });
  } catch (error) {
    console.error('Failed to update workflow data:', error);
    return NextResponse.json(
      { error: 'Failed to update workflow data' },
      { status: 500 }
    );
  }
}

// DELETE - Delete a workflow
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Workflow ID is required' },
        { status: 400 }
      );
    }

    await workflowPersistence.deleteWorkflow(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workflow:', error);
    return NextResponse.json(
      { error: 'Failed to delete workflow' },
      { status: 500 }
    );
  }
}
