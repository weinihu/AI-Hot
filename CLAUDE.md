# Core Research-Driven Development Protocol

## The Golden Rule

**Before any code implementation, conduct thorough research using specialized agents for different approaches, then synthesize findings into an optimal implementation strategy.**

## Mandatory Workflow

### 1. Problem Analysis Phase

Before writing ANY code, you MUST:

- Clearly define the problem and requirements
- Identify multiple potential solution approaches
- Determine what research is needed
- Plan which agents to use for investigation

### 2. Multi-Agent Research Phase

Deploy specialized agents to research different aspects:

```
For each significant implementation decision:
  - Use general-purpose agent to research existing patterns in codebase
  - Use domain-specific research agents for technology choices
  - Use code-reviewer agent to identify potential pitfalls
  - Use performance/security agents when relevant
```

### 3. Synthesis Phase

After agents complete research:

- Compare all proposed approaches
- Identify strengths/weaknesses of each
- Select optimal solution based on evidence
- Document decision rationale
- Plan implementation steps

### 4. Implementation Phase

Only after research synthesis:

- Implement chosen solution
- Follow patterns discovered by agents
- Apply safeguards identified during research
- Test thoroughly

## Agent Usage Patterns

### For New Features

1. **codebase-researcher**: "Find existing patterns for [feature type] in this codebase"
2. **architecture-researcher**: "Research best practices for [technical approach]"
3. **security-reviewer**: "Identify security considerations for [feature]"
4. **implementation-planner**: "Synthesize research into implementation plan"

### For Bug Fixes

1. **debugger**: "Investigate root cause of [bug]"
2. **codebase-researcher**: "Find similar patterns that work correctly"
3. **test-engineer**: "Identify test cases to prevent regression"
4. **code-reviewer**: "Review proposed fix approach"

### For Refactoring

1. **codebase-analyzer**: "Analyze current structure and dependencies"
2. **architecture-researcher**: "Research refactoring patterns for [scenario]"
3. **risk-assessor**: "Identify risks and migration strategy"
4. **test-engineer**: "Plan validation approach"

## Decision Framework

When agents provide conflicting recommendations:

1. **Evidence Quality**: Prefer recommendations with concrete examples from codebase
2. **Risk Assessment**: Choose lower-risk approaches for critical systems
3. **Maintainability**: Favor solutions consistent with existing patterns
4. **Performance**: Consider performance implications identified by agents
5. **Security**: Never ignore security concerns raised by agents

## Documentation Requirements

For every implementation:

- Document which agents were used and why
- Summarize key findings from each agent
- Explain why chosen approach was selected
- Note any trade-offs or risks accepted

## Exceptions

This protocol can be abbreviated only for:

- Simple typo fixes
- Documentation-only changes
- Configuration changes with clear precedent
- Emergency hotfixes with immediate follow-up research required

Even for exceptions, briefly note why full research was not needed.
