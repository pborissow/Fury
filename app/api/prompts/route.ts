import { NextRequest, NextResponse } from 'next/server';
import { promptPersistence, Prompt } from '@/lib/promptPersistence';

// GET /api/prompts - Get all prompts or a specific prompt
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const promptId = searchParams.get('id');

    if (promptId) {
      const prompt = await promptPersistence.loadPrompt(promptId);
      if (!prompt) {
        return NextResponse.json(
          { success: false, error: 'Prompt not found' },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, prompt });
    }

    const prompts = await promptPersistence.loadAllPrompts();
    return NextResponse.json({ success: true, prompts });
  } catch (error) {
    console.error('Error fetching prompts:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch prompts' },
      { status: 500 }
    );
  }
}

// POST /api/prompts - Create a new prompt
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, content } = body;

    if (!name || !content) {
      return NextResponse.json(
        { success: false, error: 'Name and content are required' },
        { status: 400 }
      );
    }

    const prompt: Prompt = {
      id: `prompt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await promptPersistence.savePrompt(prompt);
    return NextResponse.json({ success: true, prompt }, { status: 201 });
  } catch (error) {
    console.error('Error creating prompt:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create prompt' },
      { status: 500 }
    );
  }
}

// PUT /api/prompts - Update an existing prompt
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name, content } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Prompt ID is required' },
        { status: 400 }
      );
    }

    const updates: Partial<Prompt> = {};
    if (name !== undefined) updates.name = name;
    if (content !== undefined) updates.content = content;

    const updatedPrompt = await promptPersistence.updatePrompt(id, updates);

    if (!updatedPrompt) {
      return NextResponse.json(
        { success: false, error: 'Prompt not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, prompt: updatedPrompt });
  } catch (error) {
    console.error('Error updating prompt:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update prompt' },
      { status: 500 }
    );
  }
}

// DELETE /api/prompts?id=xxx - Delete a prompt
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const promptId = searchParams.get('id');

    if (!promptId) {
      return NextResponse.json(
        { success: false, error: 'Prompt ID is required' },
        { status: 400 }
      );
    }

    await promptPersistence.deletePrompt(promptId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting prompt:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete prompt' },
      { status: 500 }
    );
  }
}
