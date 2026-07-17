import { eq } from "drizzle-orm";

import { projects, transcripts } from "../../lib/db/schema";
import { createJobQueue } from "../../lib/jobs";
import { createTranscriber } from "../../lib/transcribe/factory";
import type { Transcriber } from "../../lib/transcribe/types";
import type { JobHandler, JobContext } from "./index";

/**
 * Note left on a project whose source has no audio track (phase-03: such
 * projects "skip cleanly"). Exported so the UI and its tests name the same
 * string the handler writes, rather than a copy of it that can drift.
 */
export const NO_AUDIO_NOTE = "no audio — captions unavailable";

export interface TranscribeHandlerOptions {
  /** Injected in tests; defaults to the `TRANSCRIBER`-driven factory. */
  createTranscriberFn?: () => Transcriber;
}

/**
 * `transcribe` — turn a project's source video into transcript segments
 * (SPEC.md § Feature checklist 2). Enqueued by the ingest handler once a
 * project is `ready`, so the metadata this reads is already written.
 *
 * The transcriber comes from `createTranscriber()` rather than being constructed
 * here: that factory is the single place `TRANSCRIBER=fake|whisper` is honoured,
 * and hardcoding either implementation would make the other unreachable.
 *
 * A project is never marked `failed` by this handler. Transcription is additive —
 * a project with no captions is still a usable video — so a genuine transcriber
 * failure rethrows and lets the queue retry, and the two expected non-failures
 * (no audio, nothing to do) are recorded rather than raised.
 */
export function createTranscribeHandler(options: TranscribeHandlerOptions = {}): JobHandler {
  const createTranscriberFn = options.createTranscriberFn ?? (() => createTranscriber());

  return async function transcribe({ job, db, setProgress }: JobContext): Promise<void> {
    const [project] = db.select().from(projects).where(eq(projects.id, job.projectId)).all();
    if (!project) {
      throw new Error(`Project ${job.projectId} not found for transcribe job ${job.id}`);
    }

    // Null is "not probed yet", which is NOT the same as "no audio". Treating it
    // as the latter would silently skip captions on a perfectly good video and
    // leave a note claiming a fact nothing established.
    if (project.hasAudio === null) {
      throw new Error(
        `Project ${project.id} ("${project.name}") has no probe metadata — its audio track is ` +
          `unknown, so transcription cannot decide whether to run. The ingest job must succeed first.`,
      );
    }

    if (!project.hasAudio) {
      db.update(projects)
        .set({ statusNote: NO_AUDIO_NOTE, transcribed: false })
        .where(eq(projects.id, project.id))
        .run();
      return;
    }

    const sourcePath = project.sourceVideoPath;
    if (!sourcePath) {
      throw new Error(`Project ${project.id} ("${project.name}") has no source video to transcribe.`);
    }

    setProgress(10);
    // `sourceName` matters even though `sourcePath` looks sufficient: uploads are
    // stored as `data/uploads/<uuid>.mp4`, so the path identifies the bytes but
    // not the media. `projects.name` is the uploaded filename unless the user
    // renamed the project, which is what lets FakeTranscriber find its fixture in
    // the real pipeline. Real transcribers ignore it.
    const segments = await createTranscriberFn().transcribe(sourcePath, {
      sourceName: project.name,
    });

    setProgress(80);
    // One transaction, and a delete before the insert: a retried attempt must
    // replace the previous transcript, not stack a second one beside it, and the
    // rows plus the flag must never be observable out of step with each other.
    db.transaction((tx) => {
      tx.delete(transcripts).where(eq(transcripts.projectId, project.id)).run();
      tx.insert(transcripts)
        .values({ projectId: project.id, segments: JSON.stringify(segments) })
        .run();
      tx.update(projects)
        .set({ transcribed: true, statusNote: null })
        .where(eq(projects.id, project.id))
        .run();
    });

    // Hand off to phase-04. Only reached on the has-audio path, so a transcript
    // exists to score; the no-audio branch above returns before here and never
    // queues a clip job that would find nothing to clip. Queued after the commit
    // so generate-clips reads a transcript that is already written.
    createJobQueue(db).enqueue("generate-clips", project.id);
  };
}
