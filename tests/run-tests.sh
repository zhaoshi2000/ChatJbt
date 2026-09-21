#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
mkdir -p out/tests
javac --release 21 -encoding UTF-8 -cp out/backend.jar -d out/tests tests/JsonTest.java
java -cp out/backend.jar:out/tests JsonTest
node --test tests/*.test.mjs
python3 tests/multi_integration.py
# Optional: install requirements-ui.txt and a Chromium binary first.
# TEST_ARTIFACTS=test-artifacts python3 tests/multi_ui_smoke.py
