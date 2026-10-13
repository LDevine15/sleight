# Launch video: "Nothing Up Our Sleeve"

Agreed with the owner on 2026-10-13. It follows the Land o' Clusters style that Puddle's launch film set: mid-century gouache,
hold-first motion and real captures only, played straight with no winking. It comes out with the claim post, after release 1.3.0
(ROADMAP 0b, step 4).

The stage is a mid-century magic act painted in gouache, lit by one spotlight on a velvet curtain. The only performer is a pair of
white gloves (sleight's icon). They take magic very seriously, are faintly smug and are never in a hurry. Every trick on stage is
a real screen capture.

## Main cut, about 40 s

1. Curtain, 2 s. Dark stage, one spotlight, the gloves resting on a table, with no text on screen.
2. The trick, 10 s. The gloves fan a deck of painted cards (app names only, no other company's logo), and the backdrop
   dissolves into a real capture: the user keeps typing in one window while sleight fills a form, plays a chess move and saves
   a file behind it. The cursor never moves. Cards: "Pick an app. Any app." then "Your Mac works in the background. Your
   cursor stays where you left it." Sound: one riffle, then silence.
3. The race, 12 s. sleight and a competitor run the same task on the same model in side-by-side captures, each with a running
   clock, and one finishes first. Card: "Same model and task, every run published."
4. The playbill, 6 s. A painted theatre program unrolls with the real benchmark table, and the gloves point at one number.
   Card: "There is no trick. It's accessibility trees."
5. The bow, 8 s. The gloves bow slowly and formally, and the curtain falls. Title: SLEIGHT. Under it: "Computer use for your
   Mac. Done behind your back." A smaller line stays up two beats: "Free. Open source. Nothing up our sleeve." The gloves clap
   once, one beat after it's comfortable, and the film cuts to black.

## Teaser, about 15 s

The race and the bow, from the clock stopping to the clap and the title. The teaser goes in the post, and the main cut goes
on the README and the launch page.

## Production rules

- Real runs only. The race exists only once sleight has won it on a published run, and it re-shoots when the numbers change.
- Capture single windows with `screencapture -l` (LAWS), never the whole screen, and scrub names from titles.
- The painted stage comes from the same gouache pipeline Land o' Clusters uses.
- It works muted, because every line is on screen. Sound is one event at a time: the riffle, then the clap.
- If a cut must lose a shot, lose the playbill first. Never the trick, the race or the bow.
- The playbill line may change once sleight's browser path stops using accessibility trees. Keep it for the native apps.
