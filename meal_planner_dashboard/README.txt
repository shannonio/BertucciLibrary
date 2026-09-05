Weekly Recipe Card Meal Planner

Open index.html in Chrome, Safari, Firefox, or Edge.

Features:
- Drag recipe cards into Breakfast, Lunch, Dinner, or Other for Sunday–Saturday.
- Plans are saved automatically on the server, so a week planned on the laptop
  is the same week on the iPad. The page re-reads when you come back to it, so
  a change made elsewhere shows up when you switch to the tab.
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
- Print the current week in a landscape weekly-plan layout (desktop only — the
  button is hidden on a phone).
- On a phone or a narrow window the layout changes: the recipe library folds up
  into a heading you tap to open, and the week becomes one day per screen that
  you swipe through, with a strip of the seven days above it to jump between
  them. A dot under a day means something is planned on it.
- Tap "+ Add" under a meal to put a recipe there. Dragging is a mouse gesture
  and does not work by touch, so this is the way to plan on an iPad or phone;
  it opens the library, and the next card you tap goes into that meal.

Keep the assets folder beside index.html so the full-resolution built-in recipe
cards open correctly.

Served from the library app it is shared: http://olympus:4173/meals/
Opened straight off disk, or with the server down, it still works — but then
both the recipe library and the week plans stay in that browser alone, and the
line beside the week says so.

The first time a browser opens the shared version, the weeks it had saved on
its own are carried up to the server. That merge only ever adds, so doing it on
the laptop and then on the iPad ends up with everything both of them had rather
than whichever one happened to be opened last. The old copies are left in the
browser untouched.
