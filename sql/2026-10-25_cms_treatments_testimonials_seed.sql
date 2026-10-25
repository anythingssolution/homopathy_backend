-- Seeds public CMS catalog for server deploy: cms_treatments + cms_testimonials.
-- Matching migration: sql/migrations/2026-10-25_001_cms_treatments.sql
-- Safe to run more than once. Must run against the API database (DB_NAME in .env).
-- Do not use DELIMITER, SOURCE, or USE.
--
-- Tables:
--   cms_treatments     NEW — create + insert 41 public treatment pages (images under /assets/)
--   cms_testimonials   existing table — insert 11 homepage reviews if missing (images under /assets/imgs/testimonial/)
--   cms_gallery_items  already on server — do not import local gallery rows
--   cms_hero_slides    unused — skip

SET @table_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'cms_treatments'
);

SET @create_ddl = IF(
  @table_exists = 0,
  'CREATE TABLE `cms_treatments` (
     `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
     `slug` VARCHAR(180) NOT NULL,
     `title_en` VARCHAR(255) NOT NULL,
     `title_hi` VARCHAR(255) NULL,
     `category` VARCHAR(64) NOT NULL DEFAULT ''Specialty'',
     `description` TEXT NOT NULL,
     `image_url` VARCHAR(700) NULL,
     `image_key` VARCHAR(700) NULL,
     `seo_title` VARCHAR(255) NULL,
     `seo_description` VARCHAR(320) NULL,
     `remedies_json` TEXT NULL,
     `sort_order` INT NOT NULL DEFAULT 0,
     `is_active` TINYINT(1) NOT NULL DEFAULT 1,
     `created_by` INT NULL,
     `updated_by` INT NULL,
     `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (`id`),
     UNIQUE KEY `uq_cms_treatments_slug` (`slug`),
     KEY `idx_cms_treatments_active_order` (`is_active`, `sort_order`, `id`)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'
);

PREPARE create_statement FROM @create_ddl;
EXECUTE create_statement;
DEALLOCATE PREPARE create_statement;


INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'kidney-stones',
    'Kidney Stones',
    'गुर्दे की पथरी',
    'Vital',
    'Kidney stones cause intense pain and urinary issues. Homeopathic remedies such as Berberis Vulgaris, Cantharis, and Lycopodium help dissolve stones, relieve pain, and prevent recurrence. At Dr. Trivedi’s Homeopathy Clinic, we provide personalized treatment plans that improve kidney function, reduce inflammation, and enhance overall urinary health. Our approach avoids invasive procedures and supports long-term kidney wellness.',
    '/assets/kidney.jpeg',
    'Kidney Stones Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic kidney stones treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Kidney stones cause intense pain and urinary issues. Homeopathic remedies such as Berberis Vulgaris, Cantharis, and Lycopodium help dissolve stones, relieve pain, and prevent recurrence. At Dr. Trivedi’s Homeopathy Clinic, we provide pers',
    '["Berberis Vulgaris","Cantharis","Lycopodium"]',
    1,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'kidney-stones'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'arthritis',
    'Arthritis',
    'गठिया',
    'Pain',
    'Arthritis causes joint stiffness, swelling, and reduced mobility. Homeopathy provides long-term relief without steroids or painkillers. Remedies like Rhus Tox, Bryonia, and Arnica help reduce inflammation and joint pain naturally. At Dr. Trivedi’s Homeopathy Clinic, we assess the type of arthritis—rheumatoid, osteoarthritis, or gout—and offer tailored treatment that improves mobility and quality of life. Our holistic approach focuses on both physical and emotional wellness.',
    '/assets/Arthritis.jpeg',
    'Arthritis Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic arthritis treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Arthritis causes joint stiffness, swelling, and reduced mobility. Homeopathy provides long-term relief without steroids or painkillers. Remedies like Rhus Tox, Bryonia, and Arnica help reduce inflammation and joint pain naturally. At Dr. Triv',
    '["Rhus Tox","Bryonia","Arnica"]',
    2,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'arthritis'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'asthma',
    'Asthma',
    'दमा',
    'Respiratory',
    'Asthma can significantly impact daily life, but homeopathy provides long-term relief by treating the root cause rather than just managing symptoms. At Dr. Trivedi’s Homeopathy Clinic, we develop personalized treatment plans that address each patient’s triggers—whether it’s allergies, weather changes, or stress. Homeopathic remedies help reduce the frequency and intensity of asthma attacks, improve lung function, and strengthen the immune system. This natural approach is safe for children and adults, and helps reduce dependency on inhalers or steroids over time.',
    '/assets/Asthma.jpeg',
    'Asthma Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic asthma treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Asthma can significantly impact daily life, but homeopathy provides long-term relief by treating the root cause rather than just managing symptoms. At Dr. Trivedi’s Homeopathy Clinic, we develop personalized treatment plans that address each pat',
    '[]',
    3,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'asthma'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'acne-pimples',
    'Acne (Pimples)',
    'मुँहासे (पिंपल्स)',
    'Skin',
    'Acne can be more than a skin issue—it affects confidence and emotional health. Homeopathy provides a holistic and side-effect-free solution by treating the underlying causes such as hormonal imbalances, digestive issues, or stress. At Dr. Trivedi’s Homeopathy Clinic, we use personalized remedies to control breakouts, reduce inflammation, and heal scars. Unlike chemical-based treatments, homeopathy restores your skin’s health from the inside out. With regular treatment, many patients notice clearer skin, reduced oiliness, and fewer flare-ups. It’s a natural, safe, and effective way to treat acne without damaging the skin.',
    '/assets/Acne.jpeg',
    'Acne (Pimples) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic acne (pimples) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Acne can be more than a skin issue—it affects confidence and emotional health. Homeopathy provides a holistic and side-effect-free solution by treating the underlying causes such as hormonal imbalances, digestive issues, or stress. At Dr',
    '[]',
    4,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'acne-pimples'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'allergies',
    'Allergies',
    'एलर्जी',
    'Immune',
    'Allergies can affect the skin, respiratory system, or digestive tract, and are often caused by environmental allergens like pollen, dust, food, or chemicals. Dr. Trivedi’s Homeopathy Clinic provides personalized remedies that build internal immunity and desensitize the body to allergens over time. Whether it''s allergic rhinitis, skin rashes, urticaria, or food intolerance, homeopathy targets the root cause and not just the symptoms. Our safe and side-effect-free treatment helps patients achieve long-term freedom from allergic reactions and improves their resistance to recurring allergy episodes.',
    '/assets/Allergies.jpeg',
    'Allergies Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic allergies treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Allergies can affect the skin, respiratory system, or digestive tract, and are often caused by environmental allergens like pollen, dust, food, or chemicals. Dr. Trivedi’s Homeopathy Clinic provides personalized remedies that build internal i',
    '[]',
    5,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'allergies'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'back-pain',
    'Back Pain',
    'पीठ दर्द',
    'Pain',
    'Back pain, whether due to injury, posture, or degenerative conditions, can severely affect mobility and daily function. Homeopathy targets the root cause—be it muscular strain, nerve compression, or spine-related disorders—offering lasting relief without side effects. Dr. Trivedi’s Homeopathy Clinic uses safe, non-addictive remedies tailored to each patient’s pain type and medical history. Our holistic treatment reduces inflammation, improves mobility, and prevents relapse, providing a sustainable, natural approach to pain management.',
    '/assets/Back Pain.jpeg',
    'Back Pain Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic back pain treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Back pain, whether due to injury, posture, or degenerative conditions, can severely affect mobility and daily function. Homeopathy targets the root cause—be it muscular strain, nerve compression, or spine-related disorders—offering lasting re',
    '[]',
    6,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'back-pain'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'bone-related-disorders',
    'Bone-related Disorders',
    'हड्डियों से संबंधित विकार',
    'Orthopedic',
    'Bone and joint issues like arthritis, osteoporosis, and back pain can severely limit mobility and quality of life. At Dr. Trivedi’s Homeopathy Clinic, we address bone-related disorders holistically. Homeopathic remedies promote better calcium absorption, reduce inflammation, and strengthen bones and connective tissues. Whether it''s joint pain due to osteoarthritis or stiffness from spondylosis, our treatments provide long-term relief without the need for painkillers or steroids. Homeopathy helps manage symptoms while also slowing down the progression of degenerative bone diseases naturally. Patients experience improved flexibility, reduced pain, and enhanced bone strength through our customized approach.',
    '/assets/Bone-related Disorders.jpeg',
    'Bone-related Disorders Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic bone-related disorders treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Bone and joint issues like arthritis, osteoporosis, and back pain can severely limit mobility and quality of life. At Dr. Trivedi’s Homeopathy Clinic, we address bone-related disorders holistically. Homeopathic remedies promote b',
    '[]',
    7,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'bone-related-disorders'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'cervical-spondylitis',
    'Cervical Spondylitis',
    'सर्वाइकल स्पॉन्डिलाइटिस',
    'Orthopedic',
    'Cervical spondylitis, a common degenerative condition of the neck spine, leads to neck pain, stiffness, and radiating discomfort in the shoulders and arms. At Dr. Trivedi’s Homeopathy Clinic, we approach cervical spondylitis holistically. Homeopathy targets the root cause by enhancing the body’s natural healing capacity, reducing inflammation, and improving mobility without the side effects of painkillers or steroids. Each patient receives a personalized treatment plan based on their symptoms, lifestyle, and medical history. Over time, homeopathic remedies can help in easing chronic pain, improving posture, and reducing recurrence. Our approach is gentle, effective, and long-lasting.',
    '/assets/Cervical Spondylitis.jpeg',
    'Cervical Spondylitis Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic cervical spondylitis treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Cervical spondylitis, a common degenerative condition of the neck spine, leads to neck pain, stiffness, and radiating discomfort in the shoulders and arms. At Dr. Trivedi’s Homeopathy Clinic, we approach cervical spondylitis holist',
    '[]',
    8,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'cervical-spondylitis'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'autism',
    'Autism',
    'ऑटिज़्म',
    'Mental',
    'At Dr. Trivedi’s Homeopathy Clinic in Raipur, we provide safe, gentle, and effective homeopathic treatment for autism spectrum disorder (ASD). Our personalized approach targets the root causes of behavioral, sensory, and communication challenges, helping children achieve better emotional balance and improved social interactions. Homeopathy enhances brain development without any side effects, making it a natural alternative to conventional therapies. Dr. Trivedi has helped many children with autism through his compassionate and result-oriented care. If you''re looking for holistic autism treatment in Raipur, Dr. Trivedi’s Homeopathy Clinic offers trusted solutions that support long-term developmental improvements in children.',
    '/assets/Autism.jpeg',
    'Autism Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic autism treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. At Dr. Trivedi’s Homeopathy Clinic in Raipur, we provide safe, gentle, and effective homeopathic treatment for autism spectrum disorder (ASD). Our personalized approach targets the root causes of behavioral, sensory, and communication challenges',
    '[]',
    9,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'autism'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'hip-pain',
    'Hip Pain',
    'कूल्हे का दर्द',
    'Pain',
    'Hip pain can be caused by arthritis, bursitis, muscle strain, or age-related degeneration. At Dr. Trivedi’s Homeopathy Clinic, we provide safe and effective homeopathic remedies that help reduce pain, inflammation, and stiffness. Unlike conventional painkillers that offer temporary relief, homeopathy promotes natural healing of the affected tissues and improves joint mobility. Our treatment plan also supports bone health, strengthens muscles, and prevents further deterioration. Whether it’s an acute injury or chronic condition, our non-invasive and holistic care offers long-term improvement without side effects.',
    '/assets/Hip Pain.jpeg',
    'Hip Pain Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic hip pain treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Hip pain can be caused by arthritis, bursitis, muscle strain, or age-related degeneration. At Dr. Trivedi’s Homeopathy Clinic, we provide safe and effective homeopathic remedies that help reduce pain, inflammation, and stiffness. Unlike conven',
    '[]',
    10,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'hip-pain'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'eye-disorders',
    'Eye Disorders',
    'आंखों के विकार',
    'Specialty',
    'From conjunctivitis to dry eyes, allergies, and blurred vision, homeopathy offers gentle, natural remedies for various eye problems. It works by stimulating the body’s healing process to address underlying causes such as infections, strain, or systemic health issues like diabetes or hypertension. At Dr. Trivedi’s Homeopathy Clinic, we provide customized solutions based on your individual symptoms and medical history. Our remedies are non-invasive and suitable for all age groups, helping to maintain healthy eyesight without any side effects.',
    '/assets/Eye Disorders.jpeg',
    'Eye Disorders Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic eye disorders treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. From conjunctivitis to dry eyes, allergies, and blurred vision, homeopathy offers gentle, natural remedies for various eye problems. It works by stimulating the body’s healing process to address underlying causes such as infections, strai',
    '[]',
    11,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'eye-disorders'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'mental-health-issues',
    'Mental Health Issues',
    'मानसिक स्वास्थ्य समस्याएँ',
    'Mental',
    'Mental health is just as vital as physical health. Homeopathy at Dr. Trivedi’s Clinic offers safe and effective treatment for anxiety, depression, stress, OCD, phobias, and sleep disorders. Our holistic approach goes beyond suppressing symptoms—we aim to balance the emotional and psychological well-being of the patient. Each prescription is personalized, considering the patient’s thoughts, behavior, lifestyle, and history. Homeopathy gently restores mental calmness, improves mood, and enhances your ability to cope with life’s challenges. Without dependency or side effects, homeopathy is a powerful tool for those seeking mental peace and emotional resilience naturally.',
    '/assets/Mental Health Issues.jpeg',
    'Mental Health Issues Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic mental health issues treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Mental health is just as vital as physical health. Homeopathy at Dr. Trivedi’s Clinic offers safe and effective treatment for anxiety, depression, stress, OCD, phobias, and sleep disorders. Our holistic approach goes beyond suppres',
    '[]',
    12,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'mental-health-issues'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'migraine',
    'Migraine',
    'माइग्रेन',
    'Neurological',
    'Migraine is a recurring, pulsating headache often accompanied by nausea, vomiting, and sensitivity to light or sound. At Dr. Trivedi’s Homeopathy Clinic, we treat migraines not just by suppressing pain, but by identifying and addressing the underlying triggers such as stress, hormonal imbalance, gastric disturbances, or lifestyle habits. Homeopathic medicines are selected based on the individual’s unique symptoms and constitution, offering long-lasting relief without any side effects. Our holistic approach helps reduce the frequency, duration, and intensity of migraine attacks while improving overall nervous system health. Homeopathy is especially beneficial for those looking for natural, non-addictive alternatives to painkillers.',
    '/assets/Migraine.jpeg',
    'Migraine Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic migraine treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Migraine is a recurring, pulsating headache often accompanied by nausea, vomiting, and sensitivity to light or sound. At Dr. Trivedi’s Homeopathy Clinic, we treat migraines not just by suppressing pain, but by identifying and addressing the un',
    '[]',
    13,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'migraine'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'piles-hemorrhoids',
    'Piles (Hemorrhoids)',
    'बवासीर (पाइल्स)',
    'Chronic',
    'Piles cause pain, itching, bleeding, and discomfort during bowel movements. At Dr. Trivedi’s Homeopathy Clinic, we offer effective non-surgical treatment for both internal and external hemorrhoids. Homeopathic medicines help shrink the swollen veins, ease bowel movements, relieve itching, and prevent recurrence. We also address associated problems like constipation and indigestion to provide holistic healing. Our gentle remedies eliminate the root cause and provide long-lasting relief without the need for surgery, making them ideal for patients seeking natural care.',
    '/assets/Piles.jpeg',
    'Piles (Hemorrhoids) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic piles (hemorrhoids) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Piles cause pain, itching, bleeding, and discomfort during bowel movements. At Dr. Trivedi’s Homeopathy Clinic, we offer effective non-surgical treatment for both internal and external hemorrhoids. Homeopathic medicines help shrink ',
    '[]',
    14,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'piles-hemorrhoids'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'prostate-issues',
    'Prostate Issues',
    'प्रोस्टेट समस्याएँ',
    'Vital',
    'Prostate enlargement, also known as BPH (Benign Prostatic Hyperplasia), is common in aging men and can lead to urinary discomfort, frequent urination, and incomplete bladder emptying. At Dr. Trivedi’s Homeopathy Clinic, we provide safe and effective remedies to manage prostate issues without surgery. Homeopathy works by reducing glandular inflammation, improving urinary flow, and restoring normal prostate function. Our remedies are tailored to your unique symptoms and medical history, ensuring targeted relief. Unlike conventional medicines, homeopathy offers long-term management without side effects or dependency. Many patients report improved urinary health, better sleep, and enhanced well-being after consistent homeopathic treatment.',
    '/assets/Prostate Issues.jpeg',
    'Prostate Issues Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic prostate issues treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Prostate enlargement, also known as BPH (Benign Prostatic Hyperplasia), is common in aging men and can lead to urinary discomfort, frequent urination, and incomplete bladder emptying. At Dr. Trivedi’s Homeopathy Clinic, we provide safe ',
    '[]',
    15,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'prostate-issues'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'lower-back-pain',
    'Lower Back Pain',
    'कमर दर्द',
    'Pain',
    'Lower back pain can arise from muscle strain, spinal issues, herniated discs, or sedentary lifestyles. Dr. Trivedi’s Homeopathy Clinic offers individualized homeopathic solutions that address pain, stiffness, and inflammation at the source. Our holistic approach supports natural healing of the musculoskeletal system and restores spine health. Homeopathic medicines also help improve posture, reduce stress-related pain, and strengthen the core without any side effects. Whether it’s acute or chronic backache, our treatment provides long-lasting relief and prevents recurrence by addressing the root cause—not just suppressing the symptoms.',
    '/assets/Lower Back Pain.jpeg',
    'Lower Back Pain Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic lower back pain treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Lower back pain can arise from muscle strain, spinal issues, herniated discs, or sedentary lifestyles. Dr. Trivedi’s Homeopathy Clinic offers individualized homeopathic solutions that address pain, stiffness, and inflammation at the sou',
    '[]',
    16,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'lower-back-pain'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'sciatica',
    'Sciatica',
    'साइटिका',
    'Pain',
    'Sciatica is characterized by shooting pain from the lower back down the legs. Homeopathy helps by targeting nerve inflammation and root causes. Remedies like Colocynthis, Mag Phos, and Gnaphalium offer effective pain relief and reduce recurrence. At Dr. Trivedi’s Homeopathy Clinic, we focus on non-invasive pain management and restoring nerve function, offering patients natural and lasting solutions.',
    '/assets/Sciatica.jpeg',
    'Sciatica Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic sciatica treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Sciatica is characterized by shooting pain from the lower back down the legs. Homeopathy helps by targeting nerve inflammation and root causes. Remedies like Colocynthis, Mag Phos, and Gnaphalium offer effective pain relief and reduce recurren',
    '["Colocynthis","Mag Phos","Gnaphalium"]',
    17,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'sciatica'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'slip-disc',
    'Slip Disc',
    'स्लिप डिस्क',
    'Orthopedic',
    'Slip disc, or herniated disc, is a painful spinal condition that can cause nerve compression, radiating pain, and restricted movement. Homeopathy provides an effective, non-surgical alternative by addressing the inflammation and improving the body''s healing response. At Dr. Trivedi’s Homeopathy Clinic, we assess each case thoroughly to customize treatment that targets the disc issue and associated muscular or nerve problems. Homeopathy not only eases pain but also helps restore mobility and prevent further degeneration.',
    '/assets/Slip Disc.jpeg',
    'Slip Disc Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic slip disc treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Slip disc, or herniated disc, is a painful spinal condition that can cause nerve compression, radiating pain, and restricted movement. Homeopathy provides an effective, non-surgical alternative by addressing the inflammation and improving the',
    '[]',
    18,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'slip-disc'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'joint-and-muscular-pain',
    'Joint and Muscular Pain',
    'जोड़ और मांसपेशियों का दर्द',
    'Pain',
    'At Dr. Trivedi''s Homeopathy Clinic, we provide effective homeopathic treatment for joint and muscular pain caused by arthritis, sprains, overuse, or chronic conditions. Homeopathy addresses the root cause of pain by enhancing the body''s natural healing response. Remedies like Rhus Toxicodendron, Arnica Montana, and Bryonia are commonly prescribed based on the individual’s symptoms, severity, and triggers. These natural remedies reduce inflammation, stiffness, and pain without any side effects. Whether it’s knee pain, shoulder discomfort, or muscle cramps, our personalized approach helps patients achieve lasting relief and improved mobility. Discover safe, non-invasive treatment for joint and muscle health.',
    '/assets/Joint and Muscular Pain.jpeg',
    'Joint and Muscular Pain Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic joint and muscular pain treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. At Dr. Trivedi''s Homeopathy Clinic, we provide effective homeopathic treatment for joint and muscular pain caused by arthritis, sprains, overuse, or chronic conditions. Homeopathy addresses the root cause of pain by enhancing th',
    '["Rhus Toxicodendron","Arnica Montana","Bryonia"]',
    19,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'joint-and-muscular-pain'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'paralysis',
    'Paralysis',
    'लकवा',
    'Neurological',
    'Paralysis results from nerve damage or brain injury, affecting the motor functions of specific body parts. Homeopathy offers supportive treatment that may stimulate nerve regeneration and restore muscle tone. At Dr. Trivedi’s Clinic, we combine individualized remedies and long-term care to improve blood circulation, minimize muscle stiffness, and gradually enhance mobility. While complete reversal depends on severity and cause, many patients report noticeable improvement with consistent treatment. Homeopathy’s non-invasive approach brings hope and comfort to paralysis patients without aggressive interventions.',
    '/assets/Paralysis.jpeg',
    'Paralysis Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic paralysis treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Paralysis results from nerve damage or brain injury, affecting the motor functions of specific body parts. Homeopathy offers supportive treatment that may stimulate nerve regeneration and restore muscle tone. At Dr. Trivedi’s Clinic, we combi',
    '[]',
    20,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'paralysis'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'thyroid-disorders',
    'Thyroid Disorders',
    'थायरॉयड विकार',
    'Vital',
    'Whether it’s hypothyroidism or hyperthyroidism, thyroid imbalance can lead to fatigue, weight changes, hair loss, and mood disturbances. At Dr. Trivedi’s Homeopathy Clinic, we treat thyroid conditions by restoring the hormonal balance naturally. Homeopathic remedies stimulate the thyroid gland, regulate metabolism, and address associated symptoms such as constipation, depression, and irregular periods. Our customized treatments are non-hormonal and free from side effects. Homeopathy is particularly effective for early-stage thyroid issues and can help reduce dependency on lifelong medications when started early. With regular monitoring and personalized care, patients often report improved energy levels, mood, and weight control.',
    '/assets/Thyroid Disorders.jpeg',
    'Thyroid Disorders Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic thyroid disorders treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Whether it’s hypothyroidism or hyperthyroidism, thyroid imbalance can lead to fatigue, weight changes, hair loss, and mood disturbances. At Dr. Trivedi’s Homeopathy Clinic, we treat thyroid conditions by restoring the hormonal balance',
    '[]',
    21,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'thyroid-disorders'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'urinary-disorders',
    'Urinary Disorders',
    'मूत्र संबंधी विकार',
    'Vital',
    'Homeopathy is highly effective in managing urinary disorders such as recurrent urinary tract infections (UTIs), burning sensation, bed-wetting, and urinary incontinence. Unlike antibiotics that offer short-term relief, homeopathy strengthens the body’s immune system and addresses the root causes like bladder irritation, kidney function imbalance, or emotional triggers. At Dr. Trivedi’s Homeopathy Clinic, each patient receives a custom treatment plan that not only relieves symptoms but also prevents recurrence. Our remedies are gentle, non-invasive, and free from harmful side effects.',
    '/assets/Urinary Disorders.jpeg',
    'Urinary Disorders Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic urinary disorders treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Homeopathy is highly effective in managing urinary disorders such as recurrent urinary tract infections (UTIs), burning sensation, bed-wetting, and urinary incontinence. Unlike antibiotics that offer short-term relief, homeopathy stre',
    '[]',
    22,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'urinary-disorders'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'heart-diseases',
    'Heart Diseases',
    'हृदय रोग',
    'Vital',
    'Heart conditions such as hypertension, palpitations, angina, and stress-induced cardiac issues can benefit from supportive homeopathic care. At Dr. Trivedi’s Homeopathy Clinic, our remedies work to regulate blood pressure, improve heart rhythm, and reduce anxiety and emotional stress—key contributors to heart ailments. While not a replacement for emergency care or surgery, homeopathy plays a vital role in long-term management and prevention. By strengthening the body’s core vitality, we aim to support overall heart health in a natural, side-effect-free manner.',
    '/assets/Heart Diseases.jpeg',
    'Heart Diseases Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic heart diseases treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Heart conditions such as hypertension, palpitations, angina, and stress-induced cardiac issues can benefit from supportive homeopathic care. At Dr. Trivedi’s Homeopathy Clinic, our remedies work to regulate blood pressure, improve heart ',
    '[]',
    23,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'heart-diseases'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'hair-fall',
    'Hair Fall',
    'बाल झड़ना',
    'Skin',
    'Hair loss, thinning, dandruff, and scalp issues can be distressing and often indicate deeper health imbalances. At Dr. Trivedi’s Homeopathy Clinic, we treat hair fall from its root causes—whether due to stress, hormonal imbalance, thyroid issues, nutritional deficiencies, or genetics. Our personalized homeopathic remedies work to strengthen hair follicles, regulate hormonal levels, and improve scalp health. Homeopathy also supports hair regrowth and controls hair thinning without harmful chemicals or side effects. With consistent treatment, patients experience reduced hair fall, better hair texture, and renewed confidence. It’s a safe and natural choice for long-term hair care and restoration.',
    '/assets/Hair Fall.jpeg',
    'Hair Fall Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic hair fall treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Hair loss, thinning, dandruff, and scalp issues can be distressing and often indicate deeper health imbalances. At Dr. Trivedi’s Homeopathy Clinic, we treat hair fall from its root causes—whether due to stress, hormonal imbalance, thyroid iss',
    '[]',
    24,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'hair-fall'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'herpes',
    'Herpes',
    'हरपीज',
    'Skin',
    'Herpes, whether oral or genital, can be emotionally and physically distressing. Homeopathy provides a natural, long-term solution by boosting immunity and reducing the frequency and intensity of outbreaks. At Dr. Trivedi’s Homeopathy Clinic, we understand the sensitivity of this condition and offer compassionate, confidential care. Our personalized remedies aim to heal lesions quickly, relieve discomfort, and minimize recurrence. Over time, homeopathy helps the body build resistance to the herpes virus, offering sustained relief and improved quality of life.',
    '/assets/Herpes.jpeg',
    'Herpes Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic herpes treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Herpes, whether oral or genital, can be emotionally and physically distressing. Homeopathy provides a natural, long-term solution by boosting immunity and reducing the frequency and intensity of outbreaks. At Dr. Trivedi’s Homeopathy Clinic, we ',
    '[]',
    25,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'herpes'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'infertility',
    'Infertility',
    'बांझपन',
    'Specialty',
    'Infertility can be emotionally challenging and physically draining for couples. At Dr. Trivedi’s Homeopathy Clinic, we offer natural and holistic homeopathic solutions to support fertility in both men and women. Homeopathy aims to correct hormonal imbalances, regulate menstrual cycles, improve sperm quality, and strengthen reproductive health—all without side effects. Our individualized treatment addresses underlying issues such as PCOS, endometriosis, stress, and thyroid imbalances that often contribute to infertility. Homeopathic medicines stimulate the body’s natural healing, enhancing the chances of conception safely and effectively. For those looking for a gentle, non-invasive, and long-term approach to fertility, homeopathy offers real hope and proven results.',
    '/assets/Infertility.jpeg',
    'Infertility Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic infertility treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Infertility can be emotionally challenging and physically draining for couples. At Dr. Trivedi’s Homeopathy Clinic, we offer natural and holistic homeopathic solutions to support fertility in both men and women. Homeopathy aims to correct h',
    '[]',
    26,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'infertility'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'dental-problems',
    'Dental Problems',
    'दांतों की समस्याएँ',
    'Specialty',
    'Toothaches, bleeding gums, sensitivity, bad breath, and recurrent infections are common dental problems that can be managed effectively through homeopathy. At Dr. Trivedi’s Homeopathy Clinic, we use gentle, non-invasive remedies that promote oral health and reduce inflammation and infection naturally. Homeopathy helps in healing dental abscesses, preventing tooth decay, and reducing gum sensitivity. It is especially beneficial for patients who fear dental procedures or cannot undergo surgery. By addressing the root cause—be it poor immunity, digestive issues, or hormonal imbalances—homeopathy offers a long-term solution to recurring dental concerns. It supports overall oral hygiene in a safe and natural way.',
    '/assets/Dental Problems.jpeg',
    'Dental Problems Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic dental problems treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Toothaches, bleeding gums, sensitivity, bad breath, and recurrent infections are common dental problems that can be managed effectively through homeopathy. At Dr. Trivedi’s Homeopathy Clinic, we use gentle, non-invasive remedies that pr',
    '[]',
    27,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'dental-problems'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'liver-problems',
    'Liver Problems',
    'लीवर की समस्याएँ',
    'Vital',
    'Liver disorders such as fatty liver, hepatitis, and cirrhosis can silently damage your health, affecting digestion, energy levels, and immunity. At Dr. Trivedi’s Homeopathy Clinic, we provide safe and natural homeopathic treatment that focuses on restoring liver function and detoxifying the body. Homeopathy works by gently stimulating the liver to function optimally, reducing inflammation, and improving bile flow. Our remedies are customized based on your symptoms, lifestyle, and medical history, offering holistic support without side effects. Whether you''re struggling with a sluggish liver, alcohol-induced damage, or chronic liver conditions, our approach helps regenerate liver cells and improve overall metabolism. Early intervention with homeopathy can prevent complications and support long-term liver health in a natural, non-invasive way.',
    '/assets/Liver Problems.jpeg',
    'Liver Problems Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic liver problems treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Liver disorders such as fatty liver, hepatitis, and cirrhosis can silently damage your health, affecting digestion, energy levels, and immunity. At Dr. Trivedi’s Homeopathy Clinic, we provide safe and natural homeopathic treatment that f',
    '[]',
    28,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'liver-problems'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'diarrhea-and-dysentery',
    'Diarrhea and Dysentery',
    'दस्त और पेचिश',
    'Digestive',
    'Frequent loose stools, abdominal cramps, and dehydration are common symptoms of diarrhea and dysentery. Instead of merely controlling the symptoms, Dr. Trivedi’s Homeopathy Clinic uses remedies that address the underlying infection, digestive weakness, or immunity issues. Homeopathy works naturally to restore gut balance, control frequent motions, and strengthen the digestive tract. It''s especially effective for children and adults who suffer from recurrent or chronic gastrointestinal issues. Our individualized approach helps prevent future episodes and promotes healthy digestion without disturbing gut flora.',
    '/assets/Diarrhea and Dysentery.jpeg',
    'Diarrhea and Dysentery Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic diarrhea and dysentery treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Frequent loose stools, abdominal cramps, and dehydration are common symptoms of diarrhea and dysentery. Instead of merely controlling the symptoms, Dr. Trivedi’s Homeopathy Clinic uses remedies that address the underlying infecti',
    '[]',
    29,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'diarrhea-and-dysentery'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'leucorrhoea',
    'Leucorrhoea',
    'श्वेत प्रदर',
    'Specialty',
    'Leucorrhoea, or excessive vaginal discharge, can be uncomfortable and distressing. At Dr. Trivedi’s Homeopathy Clinic, we offer gentle, side-effect-free treatment to address both the symptoms and root causes. Homeopathy helps control infection, reduce inflammation, and regulate hormonal imbalances that often trigger leucorrhoea. Common causes like poor hygiene, PCOD, anemia, or emotional stress are considered while prescribing remedies. Our individualized treatment plan promotes long-term relief by boosting immunity and improving reproductive health. Homeopathy also helps in managing associated symptoms like backache, fatigue, and itching, offering holistic care and restoring your confidence and comfort.',
    '/assets/Leucorrhoea.jpeg',
    'Leucorrhoea Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic leucorrhoea treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Leucorrhoea, or excessive vaginal discharge, can be uncomfortable and distressing. At Dr. Trivedi’s Homeopathy Clinic, we offer gentle, side-effect-free treatment to address both the symptoms and root causes. Homeopathy helps control infect',
    '[]',
    30,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'leucorrhoea'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'sexual-health-problems',
    'Sexual Health Problems',
    'यौन स्वास्थ्य समस्याएँ',
    'Specialty',
    'Homeopathy addresses a wide range of male and female sexual health issues, including low libido, premature ejaculation, erectile dysfunction, and hormonal imbalances. Rather than offering temporary relief, it treats the root emotional and physiological causes such as stress, anxiety, or glandular disorders. At Dr. Trivedi’s Homeopathy Clinic, we provide discreet, personalized care in a comfortable environment. Homeopathic remedies help restore confidence, improve vitality, and support reproductive health without any side effects. With over 9 years of expertise, Dr. Uttkarsh Trivedi has helped numerous patients regain a healthy sexual life naturally.',
    '/assets/Sexual Health Problems.jpeg',
    'Sexual Health Problems Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic sexual health problems treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Homeopathy addresses a wide range of male and female sexual health issues, including low libido, premature ejaculation, erectile dysfunction, and hormonal imbalances. Rather than offering temporary relief, it treats the root emot',
    '[]',
    31,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'sexual-health-problems'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'osteoarthritis',
    'Osteoarthritis',
    'ऑस्टियोआर्थराइटिस',
    'Orthopedic',
    'Osteoarthritis is a degenerative joint disease that causes pain, stiffness, and reduced mobility. Dr. Trivedi’s Homeopathy Clinic offers natural and lasting relief through customized homeopathic remedies that reduce joint inflammation, nourish cartilage, and improve joint flexibility. Homeopathy not only eases pain but also slows the degeneration of joints over time. Our treatment is particularly beneficial for knees, hips, and spine-related osteoarthritis. Since homeopathy works holistically, it also addresses associated issues like obesity, metabolic imbalance, and calcium deficiency. Patients benefit from improved mobility, better pain tolerance, and enhanced quality of life—without the risks of steroids or joint replacement.',
    '/assets/Osteoarthritis.jpeg',
    'Osteoarthritis Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic osteoarthritis treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Osteoarthritis is a degenerative joint disease that causes pain, stiffness, and reduced mobility. Dr. Trivedi’s Homeopathy Clinic offers natural and lasting relief through customized homeopathic remedies that reduce joint inflammation, n',
    '[]',
    32,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'osteoarthritis'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'sinusitis',
    'Sinusitis',
    'साइनसाइटिस',
    'Respiratory',
    'Sinusitis is the inflammation of the sinuses, often leading to headaches, facial pressure, nasal congestion, and thick mucus discharge. At Dr. Trivedi’s Homeopathy Clinic, we focus on treating the root cause of sinus infections—whether they are acute, chronic, or recurring. Homeopathic remedies help reduce inflammation of the sinus lining, clear the nasal passage, and improve immunity to prevent future infections. Our treatment is personalized based on the patient’s symptoms and triggers, such as allergies, weather changes, or respiratory issues. Unlike conventional treatments, homeopathy offers lasting relief without antibiotics or steroids, making it a safe option for children and adults alike.',
    '/assets/Sinusitis.jpeg',
    'Sinusitis Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic sinusitis treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Sinusitis is the inflammation of the sinuses, often leading to headaches, facial pressure, nasal congestion, and thick mucus discharge. At Dr. Trivedi’s Homeopathy Clinic, we focus on treating the root cause of sinus infections—whether they a',
    '[]',
    33,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'sinusitis'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'anemia-blood-deficiency',
    'Anemia (Blood Deficiency)',
    'एनीमिया (रक्त की कमी)',
    'Vital',
    'Anemia, marked by fatigue, weakness, and pale skin, can result from iron or vitamin deficiencies. Our homeopathic approach stimulates natural blood formation and absorption. Remedies such as Ferrum Phos, Cinchona, and Calcarea Phos are chosen based on the individual’s symptoms and cause of anemia. At Dr. Trivedi’s Homeopathy Clinic, we support hemoglobin improvement, correct nutrient deficiencies, and boost energy levels naturally. Homeopathy works effectively alongside a balanced diet to manage anemia holistically and safely for all age groups.',
    '/assets/Anemia.jpeg',
    'Anemia (Blood Deficiency) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic anemia (blood deficiency) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Anemia, marked by fatigue, weakness, and pale skin, can result from iron or vitamin deficiencies. Our homeopathic approach stimulates natural blood formation and absorption. Remedies such as Ferrum Phos, Cinchona, and Calcarea',
    '["Ferrum Phos","Cinchona","Calcarea Phos"]',
    34,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'anemia-blood-deficiency'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'ear-nose-throat-disorders-ent',
    'Ear, Nose & Throat Disorders (ENT)',
    'कान, नाक और गले के विकार (ईएनटी)',
    'Specialty',
    'Chronic ENT issues like sinusitis, ear infections, tonsillitis, allergic rhinitis, and sore throat are often recurring and resistant to conventional treatment. Homeopathy provides long-term relief by enhancing immune response and targeting the underlying imbalance causing ENT symptoms. Dr. Trivedi’s Homeopathy Clinic treats each patient based on their unique symptom pattern—resulting in reduced frequency, intensity, and recurrence. With no dependency on antibiotics or steroids, our homeopathic treatment is safe for all age groups and ideal for managing both acute and chronic ENT disorders.',
    '/assets/Ear, Nose & Throat Disorders (ENT).jpeg',
    'Ear, Nose & Throat Disorders (ENT) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic ear, nose & throat disorders (ent) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Chronic ENT issues like sinusitis, ear infections, tonsillitis, allergic rhinitis, and sore throat are often recurring and resistant to conventional treatment. Homeopathy provides long-term relief by enhancing immune ',
    '[]',
    35,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'ear-nose-throat-disorders-ent'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'gynecological-disorders-womens-health-issues',
    'Gynecological Disorders (Women’s Health Issues)',
    'स्त्री रोग (महिलाओं की स्वास्थ्य समस्याएँ)',
    'Specialty',
    'Homeopathy offers safe, non-hormonal treatment for gynecological problems like irregular periods, PCOD, fibroids, leucorrhoea, and menopause-related symptoms. At Dr. Trivedi’s Homeopathy Clinic, we provide individualized care that balances hormonal levels and enhances overall reproductive health. Medicines such as Pulsatilla, Sepia, and Lachesis are selected based on emotional and physical symptoms. Homeopathy gently regulates menstrual cycles, relieves pelvic pain, and addresses hormonal imbalances without side effects. Ideal for women of all ages, it promotes long-term wellness and fertility support naturally.',
    '/assets/Gynecological Disorders (Women’s Health Issues).jpeg',
    'Gynecological Disorders (Women’s Health Issues) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic gynecological disorders (women’s health issues) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Homeopathy offers safe, non-hormonal treatment for gynecological problems like irregular periods, PCOD, fibroids, leucorrhoea, and menopause-related symptoms. At Dr. Trivedi’s Homeopathy Clinic, we provid',
    '["Pulsatilla","Sepia","Lachesis"]',
    36,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'gynecological-disorders-womens-health-issues'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'pediatric-diseases-childrens-health-problems',
    'Pediatric Diseases (Children’s Health Problems)',
    'बाल रोग (बच्चों की स्वास्थ्य समस्याएँ)',
    'Pediatric',
    'Children often suffer from colds, coughs, allergies, skin conditions, and digestive issues. Our homeopathic treatment is gentle, safe, and effective for infants and children. Remedies like Chamomilla, Belladonna, and Calcarea Carb help boost immunity, reduce recurring infections, and support healthy development. At Dr. Trivedi’s Homeopathy Clinic, we treat the root causes while considering the child’s emotional and physical well-being. No harsh chemicals or side effects make homeopathy a parent’s first choice for their child’s overall health.',
    '/assets/Pediatric Diseases (Children’s Health Problems).jpeg',
    'Pediatric Diseases (Children’s Health Problems) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic pediatric diseases (children’s health problems) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Children often suffer from colds, coughs, allergies, skin conditions, and digestive issues. Our homeopathic treatment is gentle, safe, and effective for infants and children. Remedies like Chamomilla, Bel',
    '["Chamomilla","Belladonna","Calcarea Carb"]',
    37,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'pediatric-diseases-childrens-health-problems'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'skin-diseases-dermatological-issues',
    'Skin Diseases (Dermatological Issues)',
    'त्वचा रोग (डर्मेटोलॉजिकल समस्याएँ)',
    'Skin',
    'Homeopathy treats a wide range of skin conditions including eczema, psoriasis, acne, urticaria, and fungal infections. By identifying the underlying triggers—be it hormonal imbalance, allergies, or stress—we prescribe remedies such as Sulphur, Graphites, and Natrum Mur. At Dr. Trivedi’s Homeopathy Clinic, our treatment works from within to clear the skin, reduce itching, inflammation, and prevent recurrences. Homeopathy not only improves skin appearance but also enhances overall immunity and confidence naturally.',
    '/assets/Skin Diseases (Dermatological Issues).jpeg',
    'Skin Diseases (Dermatological Issues) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic skin diseases (dermatological issues) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Homeopathy treats a wide range of skin conditions including eczema, psoriasis, acne, urticaria, and fungal infections. By identifying the underlying triggers—be it hormonal imbalance, allergies, or stress—we prescr',
    '["Sulphur","Graphites","Natrum Mur"]',
    38,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'skin-diseases-dermatological-issues'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'chronic-complex-diseases',
    'Chronic & Complex Diseases',
    'पुरानी और जटिल बीमारियाँ',
    'Chronic',
    'Dr. Trivedi’s Homeopathy Clinic specializes in treating a wide range of chronic and complex diseases that are often labeled incurable by conventional medicine. Whether it’s autoimmune conditions, long-standing hormonal imbalances, psychosomatic disorders, or unexplained symptoms, homeopathy offers hope. Our individualized treatment targets the root cause of disease, strengthens the immune system, and restores balance without suppressing symptoms. With over 40 years of experience, we’ve successfully treated thousands of patients suffering from chronic illnesses—proving that homeopathy is not just alternative medicine, but effective medicine.',
    '/assets/Chronic & Complex Diseases.jpeg',
    'Chronic & Complex Diseases Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic chronic & complex diseases treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Dr. Trivedi’s Homeopathy Clinic specializes in treating a wide range of chronic and complex diseases that are often labeled incurable by conventional medicine. Whether it’s autoimmune conditions, long-standing hormonal imbala',
    '[]',
    39,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'chronic-complex-diseases'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'obesity-weight-management',
    'Obesity (Weight Management)',
    'मोटापा (वजन प्रबंधन)',
    'Chronic',
    'Homeopathy offers a safe and natural approach to weight management by targeting the root cause of obesity. Unlike crash diets or synthetic supplements, homeopathic remedies work gently to balance your metabolism, regulate hormones, and address underlying issues like thyroid imbalance, stress, or emotional eating. At Dr. Trivedi’s Homeopathy Clinic, we offer individualized treatment plans that are tailored to your body type, lifestyle, and health history. Homeopathy doesn''t just suppress appetite—it works holistically to restore overall well-being. Many patients have reported gradual, sustained weight loss without side effects. With consistent treatment and lifestyle advice, you can achieve long-term success in managing your weight naturally.',
    '/assets/Obesity (Weight Management).jpeg',
    'Obesity (Weight Management) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic obesity (weight management) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Homeopathy offers a safe and natural approach to weight management by targeting the root cause of obesity. Unlike crash diets or synthetic supplements, homeopathic remedies work gently to balance your metabolism, regulate ho',
    '[]',
    40,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'obesity-weight-management'
);

INSERT INTO `cms_treatments`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    'respiratory-issues-asthma-breathing-difficulty',
    'Respiratory Issues (Asthma, Breathing Difficulty)',
    'श्वसन समस्याएँ (दमा, सांस लेने में कठिनाई)',
    'Respiratory',
    'Chronic cough, breathlessness, wheezing, asthma, and bronchitis are common respiratory concerns that affect quality of life. At Dr. Trivedi’s Homeopathy Clinic, we use safe and effective remedies to strengthen the lungs, reduce inflammation, and improve breathing capacity. Our treatment helps manage triggers such as allergens, pollution, weather changes, or infections. Homeopathy not only relieves symptoms but also boosts immunity to prevent frequent flare-ups. It is particularly helpful for children and elderly patients who want to avoid long-term use of inhalers, steroids, or antibiotics.',
    '/assets/Respiratory Issues (Asthma, Breathing Difficulty).jpeg',
    'Respiratory Issues (Asthma, Breathing Difficulty) Treatment in Raipur | Dr. Trivedi''s Homeopathy',
    'Homeopathic respiratory issues (asthma, breathing difficulty) treatment in Raipur at Dr. Trivedi''s Homeopathy Clinic. Chronic cough, breathlessness, wheezing, asthma, and bronchitis are common respiratory concerns that affect quality of life. At Dr. Trivedi’s Homeopathy Clinic, we use safe and effective remedies to str',
    '[]',
    41,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_treatments` WHERE slug = 'respiratory-issues-asthma-breathing-difficulty'
);


INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Piles patient',
    'Piles',
    '☆ Relief from Painful Piles Without Surgery ☆',
    '/assets/imgs/testimonial/c1.jpeg',
    '["Piles"]',
    '2026-04-24',
    1,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c1.jpeg', '/site-images/images/testimonial-1.webp')
       OR (person_name = 'Piles patient' AND testimonial_text = '☆ Relief from Painful Piles Without Surgery ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Pediatrics patient',
    'Pediatrics',
    '☆ My Child Falls Sick Much Less Now ☆',
    '/assets/imgs/testimonial/c2.jpeg',
    '["Pediatrics","Immunity"]',
    '2026-04-15',
    2,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c2.jpeg', '/site-images/images/testimonial-2.webp')
       OR (person_name = 'Pediatrics patient' AND testimonial_text = '☆ My Child Falls Sick Much Less Now ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Skin patient',
    'Skin',
    '☆ Chronic Skin Allergy Finally Under Control ☆',
    '/assets/imgs/testimonial/c3.jpeg',
    '["Skin"]',
    '2026-04-02',
    3,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c3.jpeg', '/site-images/images/testimonial-3.webp')
       OR (person_name = 'Skin patient' AND testimonial_text = '☆ Chronic Skin Allergy Finally Under Control ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'ENT patient',
    'ENT',
    '☆ Recurring Throat Infection Gone Naturally ☆',
    '/assets/imgs/testimonial/c4.jpeg',
    '["ENT"]',
    '2026-03-25',
    4,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c4.jpeg', '/site-images/images/testimonial-4.webp')
       OR (person_name = 'ENT patient' AND testimonial_text = '☆ Recurring Throat Infection Gone Naturally ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Urinary patient',
    'Urinary',
    '☆ Fast Relief from Urinary Infection ☆',
    '/assets/imgs/testimonial/c5.jpeg',
    '["Urinary"]',
    '2026-03-10',
    5,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c5.jpeg', '/site-images/images/testimonial-5.webp')
       OR (person_name = 'Urinary patient' AND testimonial_text = '☆ Fast Relief from Urinary Infection ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Respiratory patient',
    'Respiratory',
    '☆ Breathing Feels Much Easier Now ☆',
    '/assets/imgs/testimonial/c6.jpeg',
    '["Respiratory"]',
    '2026-02-28',
    6,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c6.jpeg', '/site-images/images/testimonial-6.webp')
       OR (person_name = 'Respiratory patient' AND testimonial_text = '☆ Breathing Feels Much Easier Now ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Child patient',
    'Pediatrics',
    '☆ Safe Treatment That Suits My Child ☆',
    '/assets/imgs/testimonial/c7.jpeg',
    '["Pediatrics"]',
    '2026-02-15',
    7,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c7.jpeg', '/site-images/images/testimonial-7.webp')
       OR (person_name = 'Child patient' AND testimonial_text = '☆ Safe Treatment That Suits My Child ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Sinusitis patient',
    'Sinusitis',
    '☆ Sinus Headaches Reduced Significantly ☆',
    '/assets/imgs/testimonial/c8.jpeg',
    '["Sinusitis"]',
    '2026-02-01',
    8,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c8.jpeg', '/site-images/images/testimonial-8.webp')
       OR (person_name = 'Sinusitis patient' AND testimonial_text = '☆ Sinus Headaches Reduced Significantly ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Chronic patient',
    'Chronic',
    '☆ Long-Term Relief Without Heavy Medicines ☆',
    '/assets/imgs/testimonial/c9.jpeg',
    '["Chronic"]',
    '2026-01-20',
    9,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c9.jpeg', '/site-images/images/testimonial-9.webp')
       OR (person_name = 'Chronic patient' AND testimonial_text = '☆ Long-Term Relief Without Heavy Medicines ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Natural healing patient',
    'Natural Healing',
    '☆ Feeling Healthier the Natural Way ☆',
    '/assets/imgs/testimonial/c10.jpeg',
    '["Natural Healing"]',
    '2026-01-05',
    10,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c10.jpeg', '/site-images/images/testimonial-10.webp')
       OR (person_name = 'Natural healing patient' AND testimonial_text = '☆ Feeling Healthier the Natural Way ☆')
);

INSERT INTO `cms_testimonials`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    'Clinic patient',
    'Experience',
    '☆ Caring Doctor Who Listens & Treats ☆',
    '/assets/imgs/testimonial/c11.jpeg',
    '["Experience"]',
    '2025-12-20',
    11,
    1
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM `cms_testimonials`
    WHERE image_url IN ('/assets/imgs/testimonial/c11.jpeg', '/site-images/images/testimonial-11.webp')
       OR (person_name = 'Clinic patient' AND testimonial_text = '☆ Caring Doctor Who Listens & Treats ☆')
);

SELECT 'cms_treatments' AS cms_table, COUNT(*) AS row_count FROM cms_treatments
UNION ALL
SELECT 'cms_testimonials', COUNT(*) FROM cms_testimonials
UNION ALL
SELECT 'cms_gallery_items', COUNT(*) FROM cms_gallery_items;
