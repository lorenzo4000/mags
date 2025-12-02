#!/bin/bash
set -e

npm install

chmod +x ./main.js
ln -s "$(pwd)/main.js" '/usr/bin/mags'

mkdir -p "/etc/mags/"
cp ./theme.json "/etc/mags/"
