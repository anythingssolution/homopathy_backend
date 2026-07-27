ALTER TABLE master_users
    ADD COLUMN selected_branch_id BIGINT UNSIGNED NULL AFTER has_cross_module_access,
    ADD KEY idx_master_users_selected_branch (selected_branch_id),
    ADD CONSTRAINT fk_master_users_selected_branch
        FOREIGN KEY (selected_branch_id) REFERENCES master_clinic_branches (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;
