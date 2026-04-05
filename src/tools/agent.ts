/**
 * Agent Orchestration Tools
 *   #11 Agent — Launch sub-agents with model selection
 *   #10 Skill — Load skill definitions for specialized workflows
 */

import { defineTool, ToolSpec } from './types';

// ---------------------------------------------------------------------------
// #11 — Agent (Sub-agent spawning)
// ---------------------------------------------------------------------------

export const agentTool: ToolSpec = defineTool({
    name: 'Agent',
    category: 'agent',
    description:
        'Launch a sub-agent to handle a complex, multi-step task autonomously. ' +
        'The sub-agent runs with its own message history but shares the same tools. ' +
        'Specify a description and a detailed prompt. The sub-agent returns a single ' +
        'result message when done. Use this for tasks that require multiple tool calls ' +
        'or deep research that would clutter the main conversation.',
    parameters: {
        type: 'object',
        properties: {
            description: { type: 'string', description: 'Short (3-5 word) description of the sub-agent task.' },
            prompt: { type: 'string', description: 'Detailed task description for the sub-agent. Include context, constraints, and expected output.' },
            model: {
                type: 'string',
                description: 'Optional model override for the sub-agent (e.g. "gpt-4o", "claude-sonnet-4-20250514").',
            },
        },
        required: ['description', 'prompt'],
    },
    requiresConfirmation: false,
    permissionLevel: 'agent',

    async execute(args, ctx) {
        const description = args.description as string;
        const prompt = args.prompt as string;

        // Sub-agent execution is handled by the SidebarProvider's agent loop.
        // This tool signals intent — the orchestrator intercepts and runs a
        // nested agentic loop. If it reaches here directly, we fall back to
        // returning the prompt as a task description.
        ctx.postMessage?.({
            type: 'addProgress',
            value: `Sub-agent: ${description}`,
        });

        // Store the sub-agent request for the orchestrator to pick up
        ctx.turnState.set('pendingSubAgent', {
            description,
            prompt,
            model: args.model,
        });

        return `Sub-agent "${description}" queued. The orchestrator will execute it and return results.`;
    },
});

// ---------------------------------------------------------------------------
// #10 — Skill
// ---------------------------------------------------------------------------

/**
 * Skills registry — maps skill names to their prompt templates.
 * Extensible: new skills can be added here or loaded from files.
 */
const BUILT_IN_SKILLS: Record<string, { description: string; prompt: string }> = {
    'commit': {
        description: 'Create a git commit with a well-formatted message',
        prompt: 'Review all staged and unstaged changes, then create a git commit with a concise message that focuses on the "why" rather than the "what".',
    },
    'review': {
        description: 'Review code changes for bugs, style, and security issues',
        prompt: 'Review the recent code changes (git diff) for potential bugs, security vulnerabilities, style inconsistencies, and suggest improvements.',
    },
    'test': {
        description: 'Run the project test suite and report results',
        prompt: 'Discover the project test command (package.json, pytest, etc.), run the test suite, and report a summary of pass/fail results.',
    },
    'explain': {
        description: 'Explain how a piece of code works',
        prompt: 'Read the currently active file (or the file the user specified) and provide a clear, structured explanation of how it works.',
    },
    'fix': {
        description: 'Fix diagnostics errors in the workspace',
        prompt: 'Check getDiagnostics for the workspace, identify errors, read the relevant files, and apply fixes.',
    },
    'simplify': {
        description: 'Review changed code for reuse, quality, and efficiency',
        prompt: 'Review recently changed files for code quality. Look for duplication, unnecessary complexity, missing error handling, and suggest simplifications.',
    },
};

export const skillTool: ToolSpec = defineTool({
    name: 'Skill',
    category: 'agent',
    description:
        'Load and execute a skill (specialized workflow). ' +
        'Skills include both built-in shortcuts and folder-based skills with detailed instructions. ' +
        'Built-in: ' + Object.keys(BUILT_IN_SKILLS).join(', ') + '. ' +
        'Folder-based skills (e.g. xlsx, pdf, docx, frontend-design) are also available — use them by name.',
    parameters: {
        type: 'object',
        properties: {
            skill: { type: 'string', description: 'The skill name to execute, e.g. "commit", "xlsx", "pdf", "frontend-design".' },
            args: { type: 'string', description: 'Optional arguments or the user request to pass to the skill.' },
        },
        required: ['skill'],
    },
    requiresConfirmation: false,
    permissionLevel: 'agent',

    async execute(args, ctx) {
        const skillName = args.skill as string;
        const skillArgs = args.args as string | undefined;

        // 1. Check hardcoded built-in skills first
        const builtIn = BUILT_IN_SKILLS[skillName];
        if (builtIn) {
            const prompt = skillArgs ? `${builtIn.prompt}\n\nAdditional context: ${skillArgs}` : builtIn.prompt;
            ctx.turnState.set('pendingSubAgent', {
                description: `Skill: ${skillName}`,
                prompt,
            });
            return `Skill "${skillName}" loaded: ${builtIn.description}. Executing...`;
        }

        // 2. Check folder-based skills via SkillManager (if available)
        const skillManager = ctx.turnState.get('skillManager') as
            { hasSkill: (id: string) => boolean; buildSkillPrompt: (id: string, req: string) => string | null; getSkill: (id: string) => { name: string; description: string } | undefined; skills: Array<{ id: string; description: string }> } | undefined;

        if (skillManager && skillManager.hasSkill(skillName)) {
            const skill = skillManager.getSkill(skillName)!;
            const prompt = skillManager.buildSkillPrompt(skillName, skillArgs || '');
            if (prompt) {
                ctx.turnState.set('pendingSubAgent', {
                    description: `Skill: ${skill.name}`,
                    prompt,
                });
                return `Skill "${skillName}" loaded: ${skill.description}. Executing...`;
            }
        }

        // 3. Not found — list all available skills
        const builtInList = Object.entries(BUILT_IN_SKILLS)
            .map(([name, s]) => `- **${name}**: ${s.description}`)
            .join('\n');
        const folderList = skillManager
            ? skillManager.skills.map(s => `- **${s.id}**: ${s.description}`).join('\n')
            : '';
        const allSkills = folderList ? `${builtInList}\n${folderList}` : builtInList;

        return `Unknown skill "${skillName}". Available skills:\n${allSkills}`;
    },
});

// ---------------------------------------------------------------------------
// #24 — EnterPlanMode
// ---------------------------------------------------------------------------

export const enterPlanModeTool: ToolSpec = defineTool({
    name: 'EnterPlanMode',
    category: 'agent',
    description:
        'Switch to Plan Mode. In Plan Mode, you should only analyze and reason about the problem ' +
        'without executing any tools. Create a structured plan that the user can review before execution. ' +
        'Use this when you need to think through a complex task before acting.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args, ctx) {
        ctx.turnState.set('switchToPlanMode', true);
        return 'Switched to Plan Mode. Analyze the task and provide a structured plan without executing tools.';
    },
});

// ---------------------------------------------------------------------------
// #25 — ExitPlanMode
// ---------------------------------------------------------------------------

export const exitPlanModeTool: ToolSpec = defineTool({
    name: 'ExitPlanMode',
    category: 'agent',
    description:
        'Switch back to Act Mode from Plan Mode. In Act Mode, you execute tools to accomplish tasks. ' +
        'Use this after you have created a plan and are ready to execute it.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args, ctx) {
        ctx.turnState.set('switchToActMode', true);
        return 'Switched to Act Mode. You can now execute tools to implement the plan.';
    },
});

// EnterPlanMode / ExitPlanMode kept for reference but removed from active pool.
// Plan/Act switching caused the agent to get stuck — the LLM would enter plan mode
// and then never proceed to act. Better to let the model plan naturally in its response.
export const agentTools: ToolSpec[] = [agentTool, skillTool];
