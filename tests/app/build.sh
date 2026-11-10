#!/bin/sh
# Копия сайта с заглушкой вместо supabase-js → /home/claude/test/site
R=$(cd "$(dirname "$0")/../.." && pwd)
S=/home/claude/test/site
rm -rf $S && mkdir -p $S && cp -r $R/* $S/ && rm -rf $S/tests
cp $R/tests/app/mock.js $S/mock.js
sed -i "1s#.*#import { createClient } from '/mock.js';#" $S/js/main.js
