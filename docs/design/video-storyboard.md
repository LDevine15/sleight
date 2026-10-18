# Launch video: "Nothing Up Our Sleeve"

Agreed with the owner on 2026-10-13. Art direction was set with the owner on 2026-10-16 (LoC architect). The tone follows Puddle's
launch-film storyboard (`puddle/docs/design/lore-film-storyboard-2026-07-22.md`, not yet made): real captures only, played straight
with no winking. The look comes from Land o' Clusters: mid-century gouache and hold-first motion. It comes out with the claim post,
after release 1.3.0 and the claim suite (ROADMAP 1.5 and 2.2).

The stage is a mid-century magic act painted in gouache: the navy of sleight's icon, one warm spotlight and a velvet curtain. The
only performer is a pair of ivory hands, the two hands from sleight's icon. They have no arms. Each wrist breaks into painted
square dabs, blue on the right hand and ember on the left, as in the icon. The hands take magic very seriously, are faintly smug
and are never in a hurry. Every trick on stage is a real screen capture.

## Main cut, about 40 s

1. Curtain, 2 s. Dark stage, one spotlight, the hands resting on a table, with no text on screen.
2. The trick, 10 s. The hands fan seven blank cards flat, each carrying one app's name (typeset, never painted, no other company's logo), and the backdrop
   dissolves into a real capture: the user keeps typing in one window while sleight fills a form, plays a chess move and saves
   a file behind it. The cursor never moves. Cards: "Pick an app. Any app." then "Your Mac works in the background. Your
   cursor stays where you left it." Sound: one riffle, then silence.
3. The race, 12 s. sleight and a competitor run the same task on the same model in side-by-side captures, each with its real
   running clock. The runs are separate takes aligned at their start, so a small typeset line sits under the clocks: "Runs
   recorded separately, aligned at start." Card: "The hand is quicker than the eye." sleight finishes first. Then the upper hand drums its fingers on the
   table, in close-up on the stage frame, while the other clock keeps running. Card: "Same model and task, every run published."
4. The playbill, 6 s. A painted theatre program unrolls. Its top line is the act's billing, and the real benchmark table sits
   under it. The hands point at one number. Card: "There is no trick. It reads what the app says, not just what it shows."
5. The bow, 10 s. The hands rise a little, turn palms out and open, showing them empty, and hold. The curtain falls. Title: SLEIGHT. Under it: "Computer use for your
   Mac. Done behind your back." A smaller line stays up two beats: "Free. Open source. Nothing up our sleeve." The hands clap
   once, one beat after it's comfortable. Then they reach toward each other with a cursor between their fingertips (the pose
   from sleight's icon). The painting resolves into the icon itself, and the film cuts to black. Production rule: the bow never
   passes through a fingers-down pose.

App names on the cards are plain typeset text, with no logos, brand colours or lookalike type, and the claim measures every app on a
card. The end credits and the launch post carry: "App names are trademarks of their owners. sleight is not affiliated
with or endorsed by them." (owner, 2026-10-18).

## Teaser, about 15 s

The race and the bow, from the clock stopping to the icon. The teaser goes in the post, and the main cut goes on the README and
the launch page.

## Production rules

- Real runs only. The race exists only once sleight has won it on a published run, and it re-shoots when the numbers change.
- The playbill billing waits for the claim suite (owner, 2026-10-16). It repeats the claim post's measured words and claims
  nothing wider.
- Capture single windows with `screencapture -l` (LAWS), never the whole screen, and scrub names from titles. Both race arms are
  cropped to the page viewport in the same way, so neither browser's toolbar or extension icons show.
- The race is sped up. Each arm's real elapsed clock stays on screen, with a visible speed marker.
- The painted stage comes from the same gouache pipeline Land o' Clusters uses. Anything that is data (clocks, the table, the
  cards, the title) is typeset over the paint, never painted.
- It works muted, because every line is on screen. Sound is one event at a time: the riffle, then the clap.
- If a cut must lose a shot, lose the playbill first. Never the trick, the race or the bow.
- The playbill card describes how sleight reads apps. Re-check it against the engine whenever the read path changes.
