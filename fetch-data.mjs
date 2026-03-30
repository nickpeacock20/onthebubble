name: Fetch Data
on:
  schedule:
    - cron: '0 12 * * *'
  workflow_dispatch:

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install deps
        run: npm install node-fetch
      - name: Run fetch script
        run: node --input-type=module < fetch-data.js
      - name: Commit data.json
        run: |
          git config user.email "action@github.com"
          git config user.name "GitHub Action"
          git add data.json
          git commit -m "Update data.json" || echo "No changes"
          git push
