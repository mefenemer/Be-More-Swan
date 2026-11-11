-- db/help-articles-qr-links-2026-11-11.sql — Help Centre: choose the link a QR code opens (owner 2026-11-11), in the
-- Website Assistant's booking link card and the Brand Designer's flyers and design editor (src/utils/qr-link.ts).
--
-- ⚠️ Run at RELEASE, on prod with the code (and after db/help-articles-booking-meetings-2026-11-11.sql, which adds the
-- booking article's QR line). Staging can take it now. Each statement runs once (the NOT LIKE guard) and reports ok.
-- Bodies are dollar-quoted: apostrophes stay single. No semicolons inside the bodies.

BEGIN;

UPDATE help_articles SET
    content_md = replace(content_md,
$$- download a **QR code** to print for your counter, a flyer or the window. Scanning it opens your booking link.$$,
$$- download a **QR code** to print for your counter, a flyer or the window. It opens your booking link, or type a different link in the box above it and press **Make QR code**. **Download for print (SVG)** stays sharp at any size, and **Download as a picture (PNG)** suits Canva or Word.$$),
    updated_at = now()
WHERE title = 'Your Booking Link and Video Call Bookings' AND content_md NOT LIKE '%press **Make QR code**%'
RETURNING title, content_md LIKE '%press **Make QR code**%' AS ok;

UPDATE help_articles SET
    content_md = replace(content_md,
$$- If you remove your **logo** or **QR code**, a button appears to put it back.$$,
$$- If you remove your **logo** or **QR code**, a button appears to put it back.
- **QR code link** shows the link your QR code opens and lets you change it. On a design without one, **+ QR code** adds one, starting from a suggested link: your introductory offer's link, else your booking link, else your website.$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer' AND content_md NOT LIKE '%**QR code link** shows the link%'
RETURNING title, content_md LIKE '%**QR code link** shows the link%' AS ok;

UPDATE help_articles SET
    content_md = replace(content_md,
$$- Your **contact details** are never written by AI.$$,
$$- Your **QR code link** starts from your introductory offer's link, the link on your last flyer, your booking link or your website, in that order. Change it to any link you like, or leave it empty for no QR code.
- Your **contact details** are never written by AI.$$),
    updated_at = now()
WHERE title = 'Making a Printed Flyer' AND content_md NOT LIKE '%Your **QR code link** starts from%'
RETURNING title, content_md LIKE '%Your **QR code link** starts from%' AS ok;

COMMIT;
