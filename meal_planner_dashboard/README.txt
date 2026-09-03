Weekly Recipe Card Meal Planner

Open index.html in Chrome, Safari, Firefox, or Edge.

Features:
- Drag recipe cards into Breakfast, Lunch, Dinner, or Other for Sunday–Saturday.
- Plans are saved automatically in your browser for each week.
- Navigate between weeks.
- Click a recipe thumbnail/title to enlarge the full recipe card.
- Search and filter your recipe library.
- Import additional recipe-card images. Cards are uploaded to the server and
  written to data/meal-cards/ beside the app, so one added on the iPad shows up
  on every other device. The browser makes a small thumbnail at upload time so
  the grid stays quick.
- Edit any card's title, category and tags with the pencil button, and remove a
  card from the library from the same dialog. Removing is reversible: it only
  takes the card out of the picker, so weeks that already use it are untouched,
  and "Restore all" in the sidebar brings removed cards back.
- Print the current week in a landscape weekly-plan layout.

Keep the assets folder beside index.html so the full-resolution built-in recipe
cards open correctly.

Served from the library app it is shared: http://olympus:4173/meals/
Opened straight off disk, or with the server down, it still works — but then
cards added, edited or removed stay in that browser alone, and the page says so.

The week plan itself is still per-browser: what is on the server is the recipe
library, not the meals you drag onto the days.
