# AWS Voice Learning Coach

This is the AWS-oriented copy of the Voice Learning Coach. The original
project remains unchanged.

The page keeps the selectable OpenAI/Gemini provider and combines the learning
modules into one conversation:

```text
Typed question -> /api/chat SSE -> sentence buffer -> ElevenLabs TTS -> audio

Start voice session once -> persistent microphone and Realtime Scribe socket
                         -> repeated VAD commits -> /api/chat SSE
                         -> sentence buffer -> ElevenLabs TTS -> audio
```

The committed voice transcript and streaming assistant text are both shown in
the same chat. The ASR connection remains active until **End voice session** is
clicked. A partial user transcript while the coach is answering performs fast
barge-in: it aborts the current LLM request, sends `close_context` for the old
ElevenLabs TTS generation, closes its socket, stops queued browser audio, and
waits for VAD to commit and submit the replacement question.

## Why the code is intentionally simple

This project optimizes for learning rather than production file organization:

- `app/page.tsx` contains clearly marked microphone, ASR, interruption, LLM
  client, TTS, and UI sections.
- `app/api/chat/route.ts` contains request validation plus the OpenAI and Gemini
  server integrations.
- `app/api/elevenlabs/scribe-token/route.ts` and
  `app/api/elevenlabs/tts-token/route.ts` exchange the permanent ElevenLabs key
  for short-lived browser credentials.
- Permanent provider keys never enter the browser bundle.

## Run locally

Requirements: Node.js 24.6 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

```dotenv
OPENAI_API_KEY=replace-with-openai-api-key
OPENAI_MODEL=gpt-5-nano

GEMINI_API_KEY=replace-with-gemini-api-key
GEMINI_MODEL=gemini-3.5-flash-lite

ELEVENLABS_API_KEY=replace-with-elevenlabs-api-key
ELEVENLABS_VOICE_ID=OYTbf65OHHFELVut7v2H
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

Gemini free-tier input may be used by Google to improve its products. Do not
submit sensitive or customer information while using that tier.

## Test the combined flow

1. Select an LLM and send a typed message. Confirm text streams into the chat
   and speech begins after the first complete sentence.
2. Click **Start voice session** once, speak, and pause for one second. VAD
   commits the transcript and sends it automatically.
3. After the answer, speak a follow-up without clicking again.
4. While the coach is speaking, begin another question. Confirm partial speech
   stops the old response immediately and VAD submits the replacement question.
5. Confirm the interrupted partial answer remains visible but is excluded from
   later LLM context. Click **End voice session** when finished.

## TTS cancellation

There is no interruption toggle to enable in the ElevenLabs dashboard. This
application uses the multi-context TTS WebSocket and cancels in code by sending:

```json
{
  "context_id": "the-active-context-id",
  "close_context": true
}
```

The browser separately stops all decoded or scheduled audio because closing a
server context cannot retract audio that has already arrived. Since this demo
opens one TTS WebSocket per response, it closes that socket after closing the
context. A later optimization could keep one TTS WebSocket for the entire voice
session and create a fresh context ID for each answer.

## Intended AWS deployment boundary

This repository is the application copy; AWS infrastructure is not deployed
yet. The intended next stage is:

- static browser assets behind CloudFront;
- streamed `/api/chat` and token endpoints on an AWS serverless API;
- provider keys in AWS Secrets Manager;
- browser-to-ElevenLabs WebSockets for realtime ASR and TTS.

The ElevenLabs media connections stay browser-owned, so this turn-based demo
does not require ECS or a permanent WebRTC connection.

## Validate

```bash
npm run check
```

The check runs linting, TypeScript, and the production build without making
paid provider requests. A live microphone test still requires browser
permission and valid provider keys.
