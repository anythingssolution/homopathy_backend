# Import existing testimonial photos

The original website has 11 testimonial graphics. Their local copies are already
shipped by the frontend in `public/site-images/`. This import creates the CMS
records required by the current public homepage and doctor Testimonials tab.

1. Deploy the frontend containing those files, and the backend containing
   `scripts/importLocalTestimonials.js` and `data/localTestimonials.js`.
2. In the **backend application container** terminal (Coolify), run:

   ```sh
   cd /app
   node scripts/importLocalTestimonials.js
   node scripts/importLocalTestimonials.js --apply
   node scripts/importLocalTestimonials.js
   ```

The first command previews, `--apply` saves, and the final preview should report
`inserted: 0`, `skipped: 11` when all eleven archive entries are present. Refresh
CMS > Testimonials and the public homepage. No schema change is required.

The script uses the backend container's existing database environment. It runs
inside a transaction and takes a named lock to avoid concurrent imports. Existing
review text, names, visibility and sorting are preserved. Matching legacy image
URLs are localized; missing entries use neutral numbered labels, without invented
patient names, medical claims, tags or dates. The actual review remains in the
original image and can be managed through the existing CMS afterward.

The source manifest is JavaScript deliberately: this repository ignores JSON
files, which otherwise makes a data file disappear from a fresh deployment.
