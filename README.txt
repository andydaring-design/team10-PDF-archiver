Team 10 PDF to Images v1.4 - install
1. Unzip this folder.
2. chrome://extensions -> turn on Developer mode -> Load unpacked -> choose the folder.
   Updating from an earlier version: copy the new files over the old folder and press the reload icon on its card.
   (Needs Chrome 116 or newer.)
3. Tip: pin the extension (puzzle-piece icon > pin) so its icon is always in the toolbar.

Using it
1. Open a PDF - in Chrome's own viewer, or shown inside a site such as SharePoint, Teams or OneDrive - and click the
   extension's icon. The converter opens in Chrome's SIDE PANEL, next to the page, with that PDF already loaded.
   You stay on the same tab. The panel stays open when you switch tabs: "This tab: … [Add this tab's PDF]" at the top
   adds the PDF of whichever tab you are on. "open in a tab" (top right) opens the converter in a full tab instead.
   - Other PDFs open in your browser are listed underneath: press Add (or Add all).
   - PDFs shown INSIDE a website (SharePoint, Teams, OneDrive, Outlook, web PDF viewers):
       * SharePoint / OneDrive pages: the file is taken from SharePoint's own download link, with your SharePoint login
         (the original file, exactly as stored).
       * Other sites: the extension looks inside the page and its viewer frames for the PDF the viewer loaded. It also
         notices PDFs as they arrive in your tabs (even ones a viewer loads with a sign-in key) so it can read them again.
         These notes are kept in memory only, for an hour, and never leave your computer.
       * SCREEN CAPTURE - works with any viewer, even when the site does not allow downloading:
         press "Screen capture" (top of the side panel) or "Capture from the screen". The extension scrolls through
         the PDF in the tab and cuts each page out of the screenshots as its own image (name-page-001.png …).
         If the pages cannot be told apart it makes one long image instead.
         The pictures are as sharp as the screen, so ZOOM THE VIEWER IN FIRST (its + button) for sharper text.
         Keep the tab visible and do not scroll while it works; the page is scrolled back afterwards.
       * Or catch the file itself: "Catch it while it opens" -> Start, then close the PDF in that tab and open it again.
         The PDF is caught as it arrives. Chrome shows a "started debugging this browser" bar meanwhile - that is Chrome
         telling YOU; the website cannot see it.
       * "What was looked at" -> Copy details gives a report to send to whoever looks after this extension
         (sign-in keys in addresses are blanked out).
   - Right-click a link to a PDF -> "Save this PDF as images" works too, without opening the PDF first.
   - PDFs on your computer (file:///...): Chrome only lets the extension read them if you turn on
     "Allow access to file URLs" in the extension's details (the converter shows a button to get there).
     Or drop the file onto the converter.
   - The PDF is read from Chrome's cache where possible. Sites you are logged in to work, because your login is used.
     A PDF a site made just for you (e.g. after submitting a form) may not be readable again: use the PDF viewer's
     download button, then drop the file onto the converter.
   - Password-protected PDFs ask for the password.
2. Save to:
   - "A folder I choose": press "Choose folder..." and pick (or create) a folder. It is remembered; Chrome may ask
     "Allow this extension to edit files?" the first time you press Convert after a restart.
     Chrome does not allow some system folders (e.g. the whole Downloads or Documents folder on some systems) -
     make or choose a folder inside it.
   - "My Downloads folder": the images go into a subfolder of your Downloads folder (used automatically in browsers
     that do not allow folder picking, such as Brave).
   - Each PDF can get its own subfolder, named after the PDF.
   - If a file is already there: keep both (adds " (2)"), replace it, or skip it.
   - Save PDF (button on each PDF in the list): saves that PDF as a PDF file, straight away, in the place chosen here.
     A PDF loaded or caught from a tab is saved exactly as the site sent it. A screen capture is made into a PDF
     (one captured page per PDF page; a long image is cut into A4-shaped pages).
   - "Also save the PDF itself when converting": does the same for every PDF as part of Convert, next to its images.
3. Options:
   - Extract: "Each page as an image" (what you see on screen) or "The pictures inside the PDF" (the photos / scans
     embedded in it - logos used on every page are saved once; pictures smaller than the size you set are left out).
   - Pages: empty = all, or e.g. 1-3, 5, 8-  (8- means page 8 to the end).
   - Format: PNG (lossless), JPEG or WebP, with a quality slider for JPEG / WebP.
   - Size: DPI (150 for screen, 300 for print), or a fixed width / height / longest side in pixels.
     For pictures inside the PDF you can also keep the original size.
     The DPI is written into PNG and JPEG files, so they print at the PDF's real size.
   - Background: white or transparent (PNG / WebP only).
   - File names: <name>-page-001.png for pages, <name>-p001-img1.png for pictures. "File name start" replaces <name>.
   Your choices are remembered.

Everything happens on your computer: the PDF is never uploaded anywhere.
PDF rendering uses Mozilla's pdf.js (lib/, Apache 2.0 licence, see lib/PDFJS-LICENSE.txt).
