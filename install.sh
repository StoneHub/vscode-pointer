#!/bin/zsh
set -e
cd "${0:A:h}"
npx --yes @vscode/vsce@3 package --allow-missing-repository --skip-license -o pointer.vsix
code --install-extension pointer.vsix --force
ln -sf "$PWD/point" ~/.local/bin/point
