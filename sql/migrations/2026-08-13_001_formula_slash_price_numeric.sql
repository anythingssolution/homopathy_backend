-- Add slash-price numeric rule: 3+ digits after / are used as total prescription price.

ALTER TABLE `doctor_numeric_formula_rules`
  MODIFY COLUMN `rule_key` ENUM(
    'PLAIN_NUMBER',
    'SLASH_SINGLE_NUMERIC',
    'SLASH_DOUBLE_NUMERIC',
    'SLASH_PRICE_NUMERIC'
  ) NOT NULL;

ALTER TABLE `doctor_numeric_formula_rules`
  MODIFY COLUMN `amount_strategy` ENUM(
    'FIXED',
    'MULTIPLY_SUFFIX',
    'SUFFIX_AS_PRICE'
  ) NOT NULL;

INSERT INTO `doctor_numeric_formula_rules`
  (`formula_set_id`, `rule_key`, `amount_strategy`, `fixed_amount`, `multiplier_value`, `template_id`, `is_active`)
SELECT
  s.`id`,
  'SLASH_PRICE_NUMERIC',
  'SUFFIX_AS_PRICE',
  NULL,
  NULL,
  t.`id`,
  1
FROM `doctor_numeric_formula_sets` s
LEFT JOIN `doctor_numeric_formula_templates` t
  ON t.`formula_set_id` = s.`id`
 AND t.`template_code` = 'DEFAULT_444'
WHERE NOT EXISTS (
  SELECT 1
  FROM `doctor_numeric_formula_rules` r
  WHERE r.`formula_set_id` = s.`id`
    AND r.`rule_key` = 'SLASH_PRICE_NUMERIC'
);
