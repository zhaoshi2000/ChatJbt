#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
rm -rf out/backend
mkdir -p out/backend/ui
javac --release 21 -encoding UTF-8 -d out/backend common/src/*.java backend/src/*.java
cp web/* out/backend/ui/
jar --create --file out/backend.jar --main-class BackendServer -C out/backend .
echo 'Built out/backend.jar (Java 21+)'
