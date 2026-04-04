"use strict";
/**
 * Token usage and cost tracking.
 * Ported from claw-code-main harness: cost_tracker.py / models.py UsageSummary
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostTracker = void 0;
class CostTracker {
    _events = [];
    _totalInput = 0;
    _totalOutput = 0;
    record(label, inputTokens, outputTokens) {
        this._events.push({ label, inputTokens, outputTokens, timestamp: Date.now() });
        this._totalInput += inputTokens;
        this._totalOutput += outputTokens;
    }
    get totalUsage() {
        return { inputTokens: this._totalInput, outputTokens: this._totalOutput };
    }
    get totalTokens() {
        return this._totalInput + this._totalOutput;
    }
    get events() {
        return this._events;
    }
    get turnCount() {
        return this._events.length;
    }
    reset() {
        this._events = [];
        this._totalInput = 0;
        this._totalOutput = 0;
    }
    /** Format as a short status line for the UI. */
    formatStatus() {
        const total = this.totalTokens;
        if (total === 0) {
            return '';
        }
        const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        return `${k(this._totalInput)} in / ${k(this._totalOutput)} out | ${this.turnCount} turns`;
    }
}
exports.CostTracker = CostTracker;
//# sourceMappingURL=costTracker.js.map