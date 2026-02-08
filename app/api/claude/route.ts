import { NextRequest } from 'next/server';
import { sessionManager } from '@/lib/sessionManager';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { prompt, sessionId, projectPath } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Prompt is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Session ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await sessionManager.processMessage(
            sessionId,
            prompt,
            controller,
            encoder,
            [],
            projectPath
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const chunk = encoder.encode(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
          try {
            controller.enqueue(chunk);
            controller.close();
          } catch (e) {
            // Controller already closed
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
