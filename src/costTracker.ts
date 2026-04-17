/**
 * Token usage and cost tracking.
 * Ported from claw-code-main harness: cost_tracker.py / models.py UsageSummary
 *
 * Enhanced with cache token tracking, reasoning tokens, and per-model pricing
 * inspired by OpenClaude and OpenCode reference implementations.
 */

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
}

export interface CostEvent {
    label: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    cost: number;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Per-model pricing (USD per 1M tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
    // Anthropic
    'claude-sonnet-4-20250514':    { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-opus-4-20250514':      { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
    'claude-haiku-3-5-20241022':   { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
    // OpenAI
    'gpt-4o':                      { input: 2.50, output: 10, cacheRead: 1.25 },
    'gpt-4o-mini':                 { input: 0.15, output: 0.60, cacheRead: 0.075 },
    'gpt-4-turbo':                 { input: 10, output: 30 },
    'o1':                          { input: 15, output: 60, cacheRead: 7.50 },
    'o1-mini':                     { input: 1.10, output: 4.40, cacheRead: 0.55 },
    'o3':                          { input: 10, output: 40, cacheRead: 2.50 },
    'o3-mini':                     { input: 1.10, output: 4.40, cacheRead: 0.55 },
    'o4-mini':                     { input: 1.10, output: 4.40, cacheRead: 0.55 },
    // DeepSeek (via OpenRouter)
    'deepseek-chat':               { input: 0.27, output: 1.10, cacheRead: 0.07 },
    'deepseek-reasoner':           { input: 0.55, output: 2.19 },
};

/** Prefix-based fallback lookup: find the first matching prefix. */
function findPricing(model: string): ModelPricing | null {
    // Exact match first
    if (MODEL_PRICING[model]) { return MODEL_PRICING[model]; }
    // Prefix match (e.g. 'claude-sonnet-4-' matches 'claude-sonnet-4-20250514')
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        if (model.startsWith(key.replace(/-\d{8}$/, ''))) { return pricing; }
    }
    // OpenRouter format: strip provider prefix (e.g. 'anthropic/claude-sonnet-4-...')
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
        return findPricing(model.slice(slashIdx + 1));
    }
    return null;
}

/** Compute estimated cost in USD for a single turn. */
export function computeCost(model: string, usage: UsageSummary): number {
    const pricing = findPricing(model);
    if (!pricing) { return 0; }

    const perM = 1_000_000;
    let cost = 0;
    // Input tokens (non-cached)
    const nonCachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
    cost += (nonCachedInput / perM) * pricing.input;
    // Cache read
    if (pricing.cacheRead) {
        cost += (usage.cacheReadTokens / perM) * pricing.cacheRead;
    } else {
        cost += (usage.cacheReadTokens / perM) * pricing.input;
    }
    // Cache write
    if (pricing.cacheWrite) {
        cost += (usage.cacheWriteTokens / perM) * pricing.cacheWrite;
    } else {
        cost += (usage.cacheWriteTokens / perM) * pricing.input;
    }
    // Output tokens
    cost += (usage.outputTokens / perM) * pricing.output;

    return cost;
}

/** Create a zero-valued UsageSummary. */
export function emptyUsage(): UsageSummary {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export class CostTracker {
    private _events: CostEvent[] = [];
    private _totalInput = 0;
    private _totalOutput = 0;
    private _totalCacheRead = 0;
    private _totalCacheWrite = 0;
    private _totalReasoning = 0;
    private _totalCost = 0;
    private _model = '';
    private _thresholds: number[] = [1, 5, 10, 25];
    private _crossedThresholds: Set<number> = new Set();

    setModel(model: string): void {
        this._model = model;
    }

    record(label: string, usage: UsageSummary): void {
        const cost = computeCost(this._model, usage);
        this._events.push({
            label,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            cost,
            timestamp: Date.now(),
        });
        this._totalInput += usage.inputTokens;
        this._totalOutput += usage.outputTokens;
        this._totalCacheRead += usage.cacheReadTokens;
        this._totalCacheWrite += usage.cacheWriteTokens;
        this._totalReasoning += usage.reasoningTokens;
        this._totalCost += cost;
    }

    /**
     * Check if the latest record() call crossed a cost threshold.
     * Returns the threshold amount crossed, or null if none.
     * Each threshold is only reported once per session.
     */
    checkThreshold(): number | null {
        for (const t of this._thresholds) {
            if (this._totalCost >= t && !this._crossedThresholds.has(t)) {
                this._crossedThresholds.add(t);
                return t;
            }
        }
        return null;
    }

    get totalUsage(): UsageSummary {
        return {
            inputTokens: this._totalInput,
            outputTokens: this._totalOutput,
            cacheReadTokens: this._totalCacheRead,
            cacheWriteTokens: this._totalCacheWrite,
            reasoningTokens: this._totalReasoning,
        };
    }

    get totalCost(): number {
        return this._totalCost;
    }

    get totalTokens(): number {
        return this._totalInput + this._totalOutput;
    }

    get events(): readonly CostEvent[] {
        return this._events;
    }

    get turnCount(): number {
        return this._events.length;
    }

    /** Get the last event (current turn's usage). */
    get lastEvent(): CostEvent | undefined {
        return this._events[this._events.length - 1];
    }

    reset(): void {
        this._events = [];
        this._totalInput = 0;
        this._totalOutput = 0;
        this._totalCacheRead = 0;
        this._totalCacheWrite = 0;
        this._totalReasoning = 0;
        this._totalCost = 0;
        this._crossedThresholds.clear();
    }

    /** Format as a short status line for the UI. */
    formatStatus(): string {
        const total = this.totalTokens;
        if (total === 0) { return ''; }
        const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        let line = `${k(this._totalInput)} in`;
        if (this._totalCacheRead > 0) {
            line += ` (${k(this._totalCacheRead)} cached)`;
        }
        line += ` / ${k(this._totalOutput)} out`;
        if (this._totalCost > 0) {
            line += ` | $${this._totalCost < 0.01 ? this._totalCost.toFixed(4) : this._totalCost.toFixed(2)}`;
        }
        line += ` | ${this.turnCount} turns`;
        return line;
    }
}
