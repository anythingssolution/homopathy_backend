# Doctor CMS DigitalOcean Spaces Upload Flow

This document explains the complete CMS media upload architecture for:

- Hero
- Testimonials
- Gallery Images
- Gallery Videos

Storage target:
- `FILESYSTEM_DRIVER=spaces`
- DigitalOcean Spaces bucket

---

## 1. Final folder structure

This project uses **Option A**.

```txt
homeopathy-clinic/
  cms/
    global/
      hero/
        images/
          original/
            YYYY/
              MM/
          optimized/
            YYYY/
              MM/
      testimonials/
        images/
          original/
            YYYY/
              MM/
          optimized/
            YYYY/
              MM/
      gallery/
        images/
          original/
            YYYY/
              MM/
          optimized/
            YYYY/
              MM/
          thumbs/
            YYYY/
              MM/
        videos/
          original/
            YYYY/
              MM/
          posters/
            YYYY/
              MM/
```

---

## 2. Why this structure

### `homeopathy-clinic/`
App-level namespace so the bucket can be shared safely with other projects.

### `cms/global/`
Homepage CMS is currently global.
If future branch-wise content is needed, `global` can later become `branch-{id}`.

### `original/`
Keeps the original upload for backup/reference.

### `optimized/`
Used for public frontend rendering.

### `thumbs/`
Used for fast gallery cards/list rendering.

### `posters/`
Used for video preview images.

---

## 3. Environment variables

Required for Spaces mode:

```env
FILESYSTEM_DRIVER=spaces
DO_SPACES_KEY=...
DO_SPACES_SECRET=...
DO_SPACES_ENDPOINT=https://blr1.digitaloceanspaces.com
DO_SPACES_FILEENDPOINT=https://your-bucket.blr1.digitaloceanspaces.com
DO_SPACES_REGION=blr1
DO_SPACES_BUCKET=your-bucket
```

Optional tuning:

```env
CMS_IMAGE_MAX_BYTES=10485760
CMS_VIDEO_MAX_BYTES=262144000
CMS_IMAGE_OPTIMIZED_MAX_WIDTH=1600
CMS_IMAGE_THUMB_MAX_WIDTH=480
```

---

## 4. Added backend pieces

### Config
- `config/env.js`
- `config/storage.js`

### Upload helpers
- `utils/fileNaming.js`
- `utils/uploadValidation.js`
- `middleware/cmsUploadMiddleware.js`

### Media storage service
- `services/cmsMediaStorageService.js`

### Controllers
- `controllers/v1/doctor/cmsUploadController.js`

### CMS persistence
- `services/homepageCmsService.js`

### Routes
- `routes/v1/doctorRoutes.js`

### SQL
- `sql/2026-05-25_doctor_homepage_cms.sql`

---

## 5. Upload flow overview

There are now **2 separate steps**:

### Step A: Upload file to Spaces
Doctor frontend first uploads the media file.

### Step B: Save CMS item
Frontend then sends returned metadata into the CMS create/update API.

This is better than mixing binary upload directly inside CMS save forms because:
- cleaner validation
- easier retries
- reusable upload response
- future upload progress support

---

## 6. Upload endpoints

## 6.1 Image upload

### Endpoint
`POST /api/v1/doctors/cms/uploads/image?section=hero`

or

`POST /api/v1/doctors/cms/uploads/image?section=testimonials`

or

`POST /api/v1/doctors/cms/uploads/image?section=gallery`

### Content type
`multipart/form-data`

### Form field
- `file`

### What it does

#### Hero / Testimonials
- validates image
- uploads original image
- generates optimized webp version
- returns CMS-ready metadata

#### Gallery image
- validates image
- uploads original image
- generates optimized webp
- generates thumbnail webp
- returns CMS-ready metadata

---

## 6.2 Video upload

### Endpoint
`POST /api/v1/doctors/cms/uploads/video?section=gallery`

### Content type
`multipart/form-data`

### Form fields
- `file` → required video
- `poster` → optional poster image

### What it does
- validates video
- uploads original video
- if `poster` is provided, optimizes and uploads it
- else tries to generate poster from video using ffmpeg
- returns CMS-ready metadata

---

## 7. Image upload response format

```json
{
  "success": true,
  "message": "CMS image uploaded successfully",
  "data": {
    "asset_type": "IMAGE",
    "section": "hero",
    "storage": {
      "original": {
        "key": "homeopathy-clinic/cms/global/hero/images/original/2026/05/....jpg",
        "url": "https://bucket.../homeopathy-clinic/cms/global/hero/images/original/2026/05/....jpg",
        "content_type": "image/jpeg",
        "size": 123456
      },
      "optimized": {
        "key": "homeopathy-clinic/cms/global/hero/images/optimized/2026/05/....webp",
        "url": "https://bucket.../homeopathy-clinic/cms/global/hero/images/optimized/2026/05/....webp",
        "content_type": "image/webp",
        "size": 54321
      },
      "thumbnail": null
    },
    "cms_fields": {
      "image_url": "https://bucket.../optimized.webp",
      "image_key": "homeopathy-clinic/cms/global/hero/images/optimized/....webp",
      "image_original_url": "https://bucket.../original.jpg",
      "image_original_key": "homeopathy-clinic/cms/global/hero/images/original/....jpg",
      "thumb_url": null,
      "thumb_key": null,
      "image_mime_type": "image/jpeg",
      "image_size": 123456,
      "image_width": 1920,
      "image_height": 1080
    }
  }
}
```

Frontend should take `data.cms_fields` and merge it into the Hero/Testimonial/Gallery save payload.

---

## 8. Video upload response format

```json
{
  "success": true,
  "message": "CMS video uploaded successfully",
  "data": {
    "asset_type": "VIDEO",
    "section": "gallery",
    "storage": {
      "video": {
        "key": "homeopathy-clinic/cms/global/gallery/videos/original/2026/05/....mp4",
        "url": "https://bucket.../homeopathy-clinic/cms/global/gallery/videos/original/2026/05/....mp4",
        "content_type": "video/mp4",
        "size": 9000000
      },
      "poster": {
        "key": "homeopathy-clinic/cms/global/gallery/videos/posters/2026/05/....webp",
        "url": "https://bucket.../homeopathy-clinic/cms/global/gallery/videos/posters/2026/05/....webp",
        "content_type": "image/webp",
        "size": 42000
      }
    },
    "cms_fields": {
      "image_url": "https://bucket.../poster.webp",
      "image_key": "homeopathy-clinic/cms/global/gallery/videos/posters/....webp",
      "poster_url": "https://bucket.../poster.webp",
      "poster_key": "homeopathy-clinic/cms/global/gallery/videos/posters/....webp",
      "video_url": "https://bucket.../video.mp4",
      "video_key": "homeopathy-clinic/cms/global/gallery/videos/original/....mp4",
      "file_mime_type": "video/mp4",
      "file_size": 9000000,
      "image_width": 1280,
      "image_height": 720,
      "video_duration_sec": null
    }
  }
}
```

---

## 9. CMS save APIs after upload

Upload endpoint does **not** create the CMS record by itself.

After upload:

### Hero
Use:
`POST /api/v1/doctors/cms/hero`

Payload:
```json
{
  "title": "Hero title",
  "subtitle": "Hero subtitle",
  "cta_text": "Book Now",
  "cta_link": "/appointment",
  "image_url": "...optimized url...",
  "image_key": "...optimized key...",
  "image_original_url": "...original url...",
  "image_original_key": "...original key...",
  "image_mime_type": "image/jpeg",
  "image_size": 123456,
  "image_width": 1920,
  "image_height": 1080,
  "sort_order": 1,
  "is_active": true
}
```

### Testimonial
Use:
`POST /api/v1/doctors/cms/testimonials`

Payload:
```json
{
  "person_name": "Patient Name",
  "person_title": "Skin Case",
  "testimonial_text": "Very good experience",
  "image_url": "...optimized url...",
  "image_key": "...optimized key...",
  "image_original_url": "...original url...",
  "image_original_key": "...original key...",
  "image_mime_type": "image/jpeg",
  "image_size": 123456,
  "image_width": 1200,
  "image_height": 900,
  "tags": ["Skin", "Recovery"],
  "display_date": "2026-05-25",
  "sort_order": 1,
  "is_active": true
}
```

### Gallery image
Use:
`POST /api/v1/doctors/cms/gallery`

Payload:
```json
{
  "category": "MEDIA",
  "media_type": "IMAGE",
  "title": "Media coverage",
  "description": "Optional",
  "image_url": "...optimized url...",
  "image_key": "...optimized key...",
  "image_original_url": "...original url...",
  "image_original_key": "...original key...",
  "thumb_url": "...thumb url...",
  "thumb_key": "...thumb key...",
  "file_mime_type": "image/jpeg",
  "file_size": 123456,
  "image_width": 1600,
  "image_height": 1200,
  "display_date": "2026-05-25",
  "sort_order": 1,
  "is_active": true
}
```

### Gallery video
Use:
`POST /api/v1/doctors/cms/gallery`

Payload:
```json
{
  "category": "VIDEO",
  "media_type": "VIDEO",
  "title": "Doctor video",
  "description": "Optional",
  "image_url": "...poster url...",
  "image_key": "...poster key...",
  "poster_url": "...poster url...",
  "poster_key": "...poster key...",
  "video_url": "...video url...",
  "video_key": "...video key...",
  "file_mime_type": "video/mp4",
  "file_size": 9000000,
  "image_width": 1280,
  "image_height": 720,
  "display_date": "2026-05-25",
  "sort_order": 1,
  "is_active": true
}
```

---

## 10. Validation rules

### Image upload
- single extension only
- actual binary file type checked via `file-type`
- allowed:
  - jpg
  - png
  - webp
- max size from env `CMS_IMAGE_MAX_BYTES`

### Video upload
- single extension only
- actual binary file type checked via `file-type`
- allowed:
  - mp4
  - mov
  - avi
  - mkv
  - webm
- max size from env `CMS_VIDEO_MAX_BYTES`

---

## 11. Security notes

### Good protections added
- binary file signature validation
- single extension validation
- safe generated filenames
- no direct trust on original filename
- metadata stored with key + URL

### Still recommended later
- virus scan for uploads
- admin moderation workflow
- soft delete + cleanup job for unused orphan assets

---

## 12. How public frontend should consume

Public endpoint:
`GET /api/v1/public/cms/homepage`

### Hero/Testimonial
Use `image_url`

### Gallery image
Use:
- `thumb_url` for cards if needed
- `image_url` for larger preview

### Gallery video
Use:
- `poster_url` or `image_url` for preview card
- `video_url` for playback

---

## 13. Database fields added

### Hero
- `image_key`
- `image_original_url`
- `image_original_key`
- `image_mime_type`
- `image_size`
- `image_width`
- `image_height`

### Testimonials
- same image metadata fields as hero

### Gallery
- `image_key`
- `image_original_url`
- `image_original_key`
- `thumb_url`
- `thumb_key`
- `video_key`
- `poster_url`
- `poster_key`
- `file_mime_type`
- `file_size`
- `image_width`
- `image_height`
- `video_duration_sec`

---

## 14. Required deployment steps

### Step 1
Install new backend dependencies

### Step 2
Set Spaces environment variables

### Step 3
Run SQL migration:
- `sql/2026-05-25_doctor_homepage_cms.sql`

### Step 4
Restart backend

### Step 5
Frontend should first call upload API, then CMS save API

---

## 15. Suggested frontend UX flow

### Hero/Testimonial image
1. user selects image
2. frontend uploads image
3. backend returns `cms_fields`
4. frontend stores returned values in form state
5. frontend submits CMS create/update

### Gallery video
1. user selects video
2. optional poster image can be selected
3. frontend uploads video
4. backend returns video + poster metadata
5. frontend submits gallery CMS save

---

## 16. Future enhancements

Recommended next upgrades:
- direct drag-drop reorder API
- cleanup API for orphan uploads
- ffprobe duration extraction
- transcoded video variants
- CDN cache invalidation support
- branch-wise CMS media folders

