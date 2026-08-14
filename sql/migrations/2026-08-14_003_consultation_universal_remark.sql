ALTER TABLE tbl_consultations
  ADD COLUMN universal_remark VARCHAR(255) NULL AFTER quick_formula_input,
  ADD COLUMN universal_remark_hi VARCHAR(255) NULL AFTER universal_remark;
