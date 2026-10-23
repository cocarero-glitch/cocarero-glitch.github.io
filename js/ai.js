// AI features (coming soon). UI calls these; implement with a provider client later.
import { getSettings } from './settings.js';

export function isAiReady() { return false; /* flip when implemented: !!getSettings().aiKey */ }

/** Summarize one recording → string (markdown). */
export async function summarize(rec) {
  void rec; void getSettings();
  throw new Error('AI要約は近日対応です');
}

/** Answer a question using recordings as context (simple RAG: search → stuff top-N into prompt). */
export async function ask(question, recordings) {
  void question; void recordings;
  throw new Error('AIへの質問は近日対応です');
}
