# ==============================================================================
# ATC AI Agent Runner
# ==============================================================================

.PHONY: kimi glm agy

kimi:
	ollama launch opencode --model kimi-k2.6:cloud

glm:
	ollama launch opencode --model glm-5.1:cloud

agy:
	agy
