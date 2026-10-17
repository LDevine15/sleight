#!/bin/zsh
# sleight-vs-sleight A/B on the world suite's native tasks: OLD and NEW are git refs, each run from its own worktree because
# bench/run.mjs loads the plugin from its own checkout. Rounds alternate the order (old first, then new first) so neither side
# always runs first. Owner away only (the arms show windows). Score with:
#   node bench/ab-score.mjs --old ~/Projects/sleight-wt/ab-old/bench/results --new ~/Projects/sleight-wt/ab-new/bench/results --since <stamp printed below>
#   OLD=14327dd4 NEW=private/pane/auto-mode ROUNDS=3 bench/ab-sleight.sh
set -u
repo=${0:A:h:h}; OLD=${OLD:?}; NEW=${NEW:?}; ROUNDS=${ROUNDS:-3}
NATIVE=calculator-click,calculator-menu,textedit-save,textedit-drag,finder-move,preview-read,word-edit,excel-edit,textedit-calculator
HELD=textedit-edit,chess-drag,preview-pdf,finder-files,finder-rename,finder-create-folder,textedit-two-windows,textedit-window-drag,textedit-replace-save,textedit-replace-all,textedit-insert-line
TASKS=${TASKS:-$NATIVE,$HELD}
for side in old new; do
  dir=$HOME/Projects/sleight-wt/ab-$side; ref=${(P)${side:u}}
  [[ -d $dir ]] || git -C $repo worktree add --detach $dir $ref || exit 1
  git -C $dir checkout -q --detach $ref || exit 1
  [[ -e $dir/node_modules ]] || ln -s $repo/node_modules $dir/node_modules
  echo "$side: $(git -C $dir log --oneline -1)"
done
echo "since $(date -u +%Y-%m-%dT%H-%M)"
for r in $(seq 1 $ROUNDS); do
  order=(old new); (( r % 2 == 0 )) && order=(new old)
  for side in $order; do
    echo "round $r $side $(date -u +%H:%M:%S)"
    (cd $HOME/Projects/sleight-wt/ab-$side && node bench/run.mjs --suite world --arm sleight --tasks $TASKS --runs 1 \
      --model claude-haiku-5-5 --effort high --owner-away) > $HOME/Projects/sleight-wt/ab-$side-r$r.log 2>&1
    echo "round $r $side exit $?"
  done
done
