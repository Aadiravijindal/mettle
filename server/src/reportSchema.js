// JSON schema for the analysis report (Section 4 of the spec).
// Enforced via output_config.format on the Claude API call.
export const reportSchema = {
  type: 'object',
  properties: {
    aiUsageBreakdown: {
      type: 'object',
      properties: {
        percentEstimatedAIGenerated: { type: 'integer' },
        percentEstimatedOwnWork: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['percentEstimatedAIGenerated', 'percentEstimatedOwnWork', 'notes'],
      additionalProperties: false,
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'M:SS or H:MM:SS from session start' },
          end: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['start', 'end', 'label'],
        additionalProperties: false,
      },
    },
    signals: {
      type: 'object',
      properties: {
        caughtAIMistakes: { type: 'boolean' },
        understoodTheCode: { type: 'string', enum: ['high', 'medium', 'low', 'unclear'] },
        problemBreakdown: { type: 'string' },
        testedOwnWork: { type: 'boolean' },
        tabSwitchCount: { type: 'integer', description: 'Number of times candidate switched away from the tab' },
        redFlags: { type: 'array', items: { type: 'string' } },
        greenFlags: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'caughtAIMistakes',
        'understoodTheCode',
        'problemBreakdown',
        'testedOwnWork',
        'tabSwitchCount',
        'redFlags',
        'greenFlags',
      ],
      additionalProperties: false,
    },
    completed: { type: 'boolean' },
    summary: { type: 'string' },
    recommendation: {
      type: 'string',
      enum: ['strong_hire', 'hire', 'borderline', 'no_hire'],
    },
  },
  required: ['aiUsageBreakdown', 'timeline', 'signals', 'completed', 'summary', 'recommendation'],
  additionalProperties: false,
};
