---
title: Ai Problem Maker
emoji: 🏃
colorFrom: yellow
colorTo: pink
sdk: docker
pinned: false
---
# ai-problem-maker

## Local

```bash
npm install
npm run build
NODE_ENV=production PORT=7860 node server/index.js
```

## Docker

```bash
docker build -t ai-problem-maker .
docker run --rm -p 7860:7860 \
  -e LLM_BASE_URL="https://example.com/v1" \
  -e LLM_API_KEY="sk-..." \
  -e LLM_MODEL_NAME="qwen3.7-max" \
  ai-problem-maker
```
