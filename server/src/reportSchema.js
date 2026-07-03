// JSON schema for the layered founder report. Enforced via
// output_config.format on the Claude API call, so every report has exactly
// this shape. Layer order mirrors the founder page: verdict → completion →
// integrity → tool usage → tool purposes → depth of thinking → timeline.
const clock = { type: 'string', description: 'M:SS from session start' };

export const reportSchema = {
  type: 'object',
  properties: {
    // LAYER 0 — the verdict
    oneLineSummary: {
      type: 'string',
      description: 'One plain-English sentence: outcome + how they worked, readable in 3 seconds',
    },
    recommendation: {
      type: 'string',
      enum: ['strong_hire', 'hire', 'borderline', 'no_hire'],
    },

    // LAYER 1 — did they actually complete the task
    completion: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
        required: { type: 'string', description: 'What the brief required, condensed to its concrete requirements' },
        delivered: { type: 'string', description: 'What the final submission actually delivers' },
        reasoning: { type: 'string', description: 'Which requirements were met and which were not, including missed edge cases' },
        outputQuality: { type: 'string', description: 'Quality of the final output independent of how they got there: does it work, is it clean, would you ship it' },
      },
      required: ['verdict', 'required', 'delivered', 'reasoning', 'outputQuality'],
      additionalProperties: false,
    },

    // LAYER 2 — session integrity (flags with timestamps, never auto-fail)
    integrity: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['clean', 'flagged'] },
        faceFlags: {
          type: 'array',
          description: 'Webcam moments worth reviewing: no face visible for an extended stretch, or more than one face. Empty if none.',
          items: {
            type: 'object',
            properties: { at: clock, note: { type: 'string' } },
            required: ['at', 'note'],
            additionalProperties: false,
          },
        },
        voiceFlags: {
          type: 'array',
          description: 'Microphone activity segments worth listening to, from the audio-activity scan. Empty if the mic was silent.',
          items: {
            type: 'object',
            properties: { at: clock, note: { type: 'string' } },
            required: ['at', 'note'],
            additionalProperties: false,
          },
        },
        windowBehavior: {
          type: 'object',
          properties: {
            tabSwitches: { type: 'integer', description: 'Tab switches inside the recorded window' },
            focusViolations: { type: 'integer', description: 'Times focus escaped the recorded window' },
            note: { type: 'string', description: 'Plain-language description of away periods and whether the frames account for them' },
          },
          required: ['tabSwitches', 'focusViolations', 'note'],
          additionalProperties: false,
        },
        notes: { type: 'string', description: 'Overall integrity read. Flags are pointers for the founder to review — never a cheating verdict.' },
      },
      required: ['status', 'faceFlags', 'voiceFlags', 'windowBehavior', 'notes'],
      additionalProperties: false,
    },

    // LAYER 3 — what tools they used, and how much
    toolUsage: {
      type: 'object',
      properties: {
        percentOwnWork: { type: 'integer', description: '0-100, portion of the final work that is their own typing/editing' },
        percentAiAssisted: { type: 'integer', description: '0-100, portion that came from AI/tool output. Must sum to 100 with percentOwnWork' },
        tools: {
          type: 'array',
          description: 'One entry per distinct tool seen in the frames, plus one "Own typing/editing" entry',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'e.g. "Claude.ai", "ChatGPT", "Google Search", "Stack Overflow", "Own typing/editing"' },
              kind: { type: 'string', enum: ['ai', 'search', 'docs', 'editor', 'other'] },
              minutes: { type: 'number', description: 'Estimated minutes spent, from frame timestamps and tab-switch events' },
              timesOpened: { type: 'integer', description: 'Distinct visits/uses' },
            },
            required: ['name', 'kind', 'minutes', 'timesOpened'],
            additionalProperties: false,
          },
        },
        notes: { type: 'string', description: 'How the estimate was derived and how confident it is' },
      },
      required: ['percentOwnWork', 'percentAiAssisted', 'tools', 'notes'],
      additionalProperties: false,
    },

    // LAYER 4 — what each tool use was actually for
    toolPurposes: {
      type: 'array',
      description: 'Timestamped purpose of every AI/tool interaction visible in the frames — the why behind each use',
      items: {
        type: 'object',
        properties: {
          at: clock,
          tool: { type: 'string' },
          purpose: { type: 'string', description: 'e.g. "Asked for a first-draft implementation of the fix", "Pasted an error message to debug"' },
        },
        required: ['at', 'tool', 'purpose'],
        additionalProperties: false,
      },
    },

    // LAYER 5 — depth of their own thinking
    thinking: {
      type: 'object',
      properties: {
        rating: { type: 'string', enum: ['low', 'medium', 'high'] },
        greenFlags: { type: 'array', items: { type: 'string' }, description: 'Evidence of real understanding, each tied to something visible' },
        redFlags: { type: 'array', items: { type: 'string' }, description: 'Evidence of surface-level or blind reliance, each tied to something visible' },
        evidence: { type: 'string', description: 'The specific observations justifying the rating — never the label alone' },
      },
      required: ['rating', 'greenFlags', 'redFlags', 'evidence'],
      additionalProperties: false,
    },

    // LAYER 6 — the timeline (chapters, synced to the video)
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: clock,
          end: clock,
          label: { type: 'string' },
        },
        required: ['start', 'end', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'oneLineSummary',
    'recommendation',
    'completion',
    'integrity',
    'toolUsage',
    'toolPurposes',
    'thinking',
    'timeline',
  ],
  additionalProperties: false,
};
