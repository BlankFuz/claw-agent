/**
 * Token usage and cost tracking.
 * Ported from claw-code-main harness: cost_tracker.py / models.py UsageSummary
 */

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
}

export interface CostEvent {
    label: string;
    inputTokens: number;
    outputTokens: number;
    timestamp: number;
}

export class CostTracker {
    private _events: CostEvent[] = [];
    private _totalInput = 0;
    private _totalOutput = 0;

    record(label: string, inputTokens: number, outputTokens: number): void {
        this._events.push({ label, inputTokens, outputTokens, timestamp: Date.now() });
        this._totalInput += inputTokens;
        this._totalOutput += outputTokens;
    }

    get totalUsage(): UsageSummary {
        return { inputTokens: this._totalInput, outputTokens: this._totalOutput };
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

    reset(): void {
        this._events = [];
        this._totalInput = 0;
        this._totalOutput = 0;
    }

    /** Format as a short status line for the UI. */
    formatStatus(): string {
        const total = this.totalTokens;
        if (total === 0) { return ''; }
        const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        return `${k(this._totalInput)} in / ${k(this._totalOutput)} out | ${this.turnCount} turns`;
    }
}
