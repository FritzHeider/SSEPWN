import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Box, SubjectDetector } from "./types";

/**
 * Real `SubjectDetector` backed by face detection from `@vladmandic/human`
 * (SPEC.md § Tech stack: "face detection via @vladmandic/human (TF.js, CPU) with
 * center-weighted fallback when no face is found"). Only ever runs in the worker
 * and in the opt-in `CROP_SMOKE=1` test — the default suite and every unit test
 * use `FakeDetector`, so `npm test` never needs TF.js or the models on disk.
 *
 * Like `WhisperCppTranscriber`, this treats a heavy ML backend as an EXTERNAL,
 * documented, opt-in dependency rather than a committed npm package: neither
 * `@vladmandic/human` nor `@tensorflow/tfjs-node` is in `package.json`, and the
 * face models are gitignored and fetched once by `scripts/make-fixtures.sh`
 * (README § Smart crop). That keeps `npm install && npm run fixtures && npm test`
 * fast and network-free on a fresh machine — the whole point of routing crop
 * through the `SubjectDetector` interface. Both packages are pulled in via a
 * runtime dynamic `import`, so a build without them still type-checks, lints, and
 * runs the default suite; the moment `detect` is actually called without them it
 * throws an actionable Error naming exactly what to install, honouring the
 * `SubjectDetector` contract's "no backend ⇒ throw, never silently return []".
 */

/** Default directory the vendored Human face models live in (gitignored). */
export const DEFAULT_HUMAN_MODELS_PATH = "models/human";

/** Where to load Human's models from; overridable for a non-default checkout. */
export function humanModelsPath(): string {
  return process.env.HUMAN_MODELS_PATH || DEFAULT_HUMAN_MODELS_PATH;
}

/**
 * TF.js backend Human runs on. Defaults to `tensorflow` (the `@tensorflow/tfjs-node`
 * CPU backend the Node build expects) — NOT a GPU backend, per the global
 * "no GPU dependencies" constraint. Overridable (e.g. `wasm`) for environments
 * that wire a different tfjs backend.
 */
export function humanBackend(): string {
  return process.env.HUMAN_BACKEND || "tensorflow";
}

/**
 * The slice of the `@vladmandic/human` API this detector touches, typed
 * structurally so the module can be dynamic-imported without a compile-time
 * dependency on the package. Only face detection is enabled; mesh/iris/emotion
 * and every non-face model stay off, so a single lightweight detector model is
 * all `scripts/make-fixtures.sh` has to fetch.
 */
interface HumanFace {
  /** Normalised box `[x, y, w, h]`, each 0–1 — Human's own 0–1 output. */
  boxRaw?: [number, number, number, number];
  /** Pixel box `[x, y, w, h]`; fallback when `boxRaw` is absent. */
  box?: [number, number, number, number];
  /** Detection confidence 0–1 (Human exposes it under a few names by version). */
  score?: number;
  faceScore?: number;
  boxScore?: number;
}

interface HumanResult {
  face?: HumanFace[];
}

interface HumanTensor {
  dispose(): void;
}

interface HumanTf {
  node?: { decodeImage(data: Uint8Array | Buffer, channels?: number): HumanTensor };
  dispose(t: unknown): void;
}

interface HumanInstance {
  tf: HumanTf;
  load(): Promise<unknown>;
  detect(input: unknown): Promise<HumanResult>;
}

type HumanCtor = new (config: Record<string, unknown>) => HumanInstance;

/** Clamp to the normalised `[0, 1]` range `planCrop` expects. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function faceToBox(face: HumanFace): Box | null {
  const raw = face.boxRaw;
  if (!raw || raw.length !== 4) return null; // only trust Human's normalised box
  const confidence = face.score ?? face.faceScore ?? face.boxScore ?? 0;
  const box: Box = {
    x: clamp01(raw[0]),
    y: clamp01(raw[1]),
    w: clamp01(raw[2]),
    h: clamp01(raw[3]),
    confidence: clamp01(confidence),
  };
  // A zero-area box carries no position information for planCrop to center on.
  if (box.w <= 0 || box.h <= 0) return null;
  return box;
}

/**
 * Config handed to `new Human(...)`. Everything but the face DETECTOR is disabled:
 * `planCrop` only needs a subject's bounding box, so mesh/iris/description/emotion
 * and the body/hand/object/gesture/segmentation models are off — smaller memory
 * footprint and fewer model files to vendor.
 */
function buildConfig(modelsDir: string): Record<string, unknown> {
  const absModels = path.resolve(modelsDir);
  return {
    backend: humanBackend(),
    // `file://` URL so the Node/tfjs io layer loads models from local disk.
    modelBasePath: pathToFileURL(absModels + path.sep).href,
    debug: false,
    // Cache off: sampled frames are unrelated stills, so frame-to-frame result
    // caching would only muddy detection, never speed a fresh clip up.
    cacheSensitivity: 0,
    filter: { enabled: false },
    face: {
      enabled: true,
      detector: { rotation: false, maxDetected: 10, minConfidence: 0.2, return: false },
      mesh: { enabled: false },
      iris: { enabled: false },
      description: { enabled: false },
      emotion: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  };
}

async function loadHumanModule(): Promise<HumanCtor> {
  let mod: Record<string, unknown>;
  try {
    // String specifier defeats bundler/type resolution: the package is an
    // optional external dep (README § Smart crop), never bundled into the app.
    mod = (await import("@vladmandic/human" as string)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      "HumanFaceDetector: '@vladmandic/human' is not installed. It is an opt-in " +
        "dependency for real smart-crop — install it and '@tensorflow/tfjs-node', " +
        "then fetch the models (see README § Smart crop / scripts/make-fixtures.sh). " +
        "The default test suite uses FakeDetector and needs neither.",
      { cause: cause as Error },
    );
  }
  const ctor = (mod.Human ?? mod.default ?? mod) as HumanCtor | undefined;
  if (typeof ctor !== "function") {
    throw new Error("HumanFaceDetector: '@vladmandic/human' did not export a Human constructor.");
  }
  return ctor;
}

/**
 * Face-detecting `SubjectDetector`. Lazily loads the package and models on the
 * first `detect` call (never in the constructor — so importing this module, e.g.
 * to wire it into the worker's handler registry, pulls in no TF.js and touches
 * no disk). Subsequent calls reuse the one loaded `Human` instance.
 */
export class HumanFaceDetector implements SubjectDetector {
  private readonly modelsDir: string;
  private humanPromise: Promise<HumanInstance> | null = null;

  constructor(options: { modelsDir?: string } = {}) {
    this.modelsDir = options.modelsDir ?? humanModelsPath();
  }

  private async human(): Promise<HumanInstance> {
    if (!this.humanPromise) {
      this.humanPromise = this.initHuman().catch((err) => {
        // Reset so a transient failure (models still downloading) can be retried
        // on the next call instead of poisoning the detector for its lifetime.
        this.humanPromise = null;
        throw err;
      });
    }
    return this.humanPromise;
  }

  private async initHuman(): Promise<HumanInstance> {
    const modelsDir = path.resolve(this.modelsDir);
    try {
      await access(modelsDir);
    } catch {
      throw new Error(
        `HumanFaceDetector: models directory '${modelsDir}' not found. Fetch the ` +
          "@vladmandic/human face models there (CROP_MODELS=1 npm run fixtures, or see " +
          "README § Smart crop), or set HUMAN_MODELS_PATH to their location.",
      );
    }
    const Human = await loadHumanModule();
    const human = new Human(buildConfig(modelsDir));
    try {
      await human.load();
    } catch (cause) {
      throw new Error(
        `HumanFaceDetector: failed to load face models from '${modelsDir}'. Ensure the ` +
          "detector model files are present and complete (see README § Smart crop).",
        { cause: cause as Error },
      );
    }
    return human;
  }

  async detect(framePngPath: string): Promise<Box[]> {
    const human = await this.human();
    const decode = human.tf.node?.decodeImage;
    if (!decode) {
      throw new Error(
        "HumanFaceDetector: active TF.js backend has no image decoder " +
          "(expected '@tensorflow/tfjs-node'). Install it, or set HUMAN_BACKEND to a " +
          "backend that can decode PNGs. See README § Smart crop.",
      );
    }
    const bytes = await readFile(framePngPath);
    const tensor = decode.call(human.tf.node, bytes, 3);
    try {
      const result = await human.detect(tensor);
      const faces = result.face ?? [];
      return faces.map(faceToBox).filter((b): b is Box => b !== null);
    } finally {
      tensor.dispose();
    }
  }
}
