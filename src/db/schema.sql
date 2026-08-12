CREATE TABLE IF NOT EXISTS locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(50) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL DEFAULT 'greenhouse',
  capacity INT NOT NULL DEFAULT 0,
  description TEXT NULL,
  region VARCHAR(120) NULL,
  address VARCHAR(255) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  is_source TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  username VARCHAR(80) NOT NULL UNIQUE,
  email VARCHAR(120) NULL UNIQUE,
  phone VARCHAR(40) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'operator',
  location_id INT NULL,
  avatar_path VARCHAR(255) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  jti CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  logged_out_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  INDEX idx_auth_sessions_user_id (user_id),
  INDEX idx_auth_sessions_jti (jti)
);

CREATE TABLE IF NOT EXISTS seedling_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(50) NOT NULL UNIQUE,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rootstock_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS varieties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seedling_type_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(50) NOT NULL UNIQUE,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seedling_type_id) REFERENCES seedling_types(id)
    ON DELETE RESTRICT,
  INDEX idx_varieties_seedling_type_id (seedling_type_id)
);

CREATE TABLE IF NOT EXISTS seedling_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_code VARCHAR(80) NOT NULL UNIQUE,
  seedling_type_id INT NOT NULL,
  variety_id INT NOT NULL,
  rootstock_type_id INT NULL,
  source_location_id INT NOT NULL,
  received_date DATE NOT NULL,
  initial_quantity INT NOT NULL,
  notes TEXT NULL,
  label_code_type VARCHAR(20) NOT NULL DEFAULT 'qr',
  qr_payload LONGTEXT NULL,
  barcode_value VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seedling_type_id) REFERENCES seedling_types(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (variety_id) REFERENCES varieties(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (rootstock_type_id) REFERENCES rootstock_types(id)
    ON DELETE SET NULL,
  FOREIGN KEY (source_location_id) REFERENCES locations(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_batches_source_location_id (source_location_id),
  INDEX idx_batches_variety_id (variety_id),
  INDEX idx_batches_rootstock_type_id (rootstock_type_id)
);

CREATE TABLE IF NOT EXISTS seedling_inventory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  location_id INT NOT NULL,
  current_stage VARCHAR(50) NOT NULL DEFAULT 'received',
  quantity_available INT NOT NULL DEFAULT 0,
  defect_quantity INT NOT NULL DEFAULT 0,
  last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE RESTRICT,
  UNIQUE KEY uq_inventory_batch_location_stage (batch_id, location_id, current_stage),
  INDEX idx_inventory_location_id (location_id),
  INDEX idx_inventory_stage (current_stage)
);

CREATE TABLE IF NOT EXISTS seedling_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  inventory_id INT NULL,
  action_type VARCHAR(50) NOT NULL,
  from_location_id INT NULL,
  to_location_id INT NULL,
  previous_stage VARCHAR(50) NULL,
  next_stage VARCHAR(50) NULL,
  quantity INT NOT NULL DEFAULT 0,
  defect_quantity INT NOT NULL DEFAULT 0,
  image_paths LONGTEXT NULL,
  stage_date DATETIME NULL,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'approved',
  requires_approval TINYINT(1) NOT NULL DEFAULT 0,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  approval_note VARCHAR(255) NULL,
  reference_type VARCHAR(50) NULL,
  reference_id INT NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (inventory_id) REFERENCES seedling_inventory(id)
    ON DELETE SET NULL,
  FOREIGN KEY (from_location_id) REFERENCES locations(id)
    ON DELETE SET NULL,
  FOREIGN KEY (to_location_id) REFERENCES locations(id)
    ON DELETE SET NULL,
  FOREIGN KEY (approved_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_history_batch_id (batch_id),
  INDEX idx_history_reference (reference_type, reference_id),
  INDEX idx_history_approval_status (approval_status)
);

CREATE TABLE IF NOT EXISTS seedling_scan_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  inventory_id INT NULL,
  user_id INT NULL,
  location_id INT NULL,
  code_type VARCHAR(20) NOT NULL DEFAULT 'qr',
  raw_code LONGTEXT NULL,
  payload_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (inventory_id) REFERENCES seedling_inventory(id)
    ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE SET NULL,
  INDEX idx_seedling_scan_events_batch_id (batch_id),
  INDEX idx_seedling_scan_events_user_id (user_id),
  INDEX idx_seedling_scan_events_location_id (location_id)
);

CREATE TABLE IF NOT EXISTS transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transfer_code VARCHAR(80) NOT NULL UNIQUE,
  batch_id INT NOT NULL,
  from_inventory_id INT NOT NULL,
  from_location_id INT NOT NULL,
  to_location_id INT NOT NULL,
  quantity INT NOT NULL,
  transfer_type VARCHAR(30) NOT NULL DEFAULT 'movement',
  transfer_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stage_on_transfer VARCHAR(50) NOT NULL,
  note TEXT NULL,
  notes TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending_sender',
  created_by INT NULL,
  sender_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  sender_confirmed_by INT NULL,
  sender_confirmed_at DATETIME NULL,
  head_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  head_confirmed_by INT NULL,
  head_confirmed_at DATETIME NULL,
  receiver_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  receiver_confirmed_by INT NULL,
  receiver_confirmed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (from_inventory_id) REFERENCES seedling_inventory(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (from_location_id) REFERENCES locations(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (to_location_id) REFERENCES locations(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (sender_confirmed_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (head_confirmed_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (receiver_confirmed_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_transfers_status (status),
  INDEX idx_transfers_batch_id (batch_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_number VARCHAR(80) NOT NULL UNIQUE,
  client_name VARCHAR(120) NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(40) NULL,
  location_id INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'new',
  order_date DATETIME NULL,
  note TEXT NULL,
  notes TEXT NULL,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_quantity INT NOT NULL DEFAULT 0,
  quantity INT NOT NULL DEFAULT 0,
  fulfilled_quantity INT NOT NULL DEFAULT 0,
  shortage_quantity INT NOT NULL DEFAULT 0,
  expected_date DATE NULL,
  batch_id INT NULL,
  seedling_type_id INT NULL,
  variety_id INT NULL,
  created_by INT NULL,
  sold_by INT NULL,
  sold_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (sold_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_orders_status (status),
  INDEX idx_orders_location_id (location_id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  batch_id INT NOT NULL,
  inventory_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
    ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE RESTRICT,
  FOREIGN KEY (inventory_id) REFERENCES seedling_inventory(id)
    ON DELETE RESTRICT,
  INDEX idx_order_items_order_id (order_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  description TEXT NULL,
  location_id INT NULL,
  assigned_to INT NULL,
  created_by INT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  priority VARCHAR(30) NOT NULL DEFAULT 'medium',
  due_date DATETIME NULL,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE SET NULL,
  FOREIGN KEY (assigned_to) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_tasks_status (status),
  INDEX idx_tasks_priority (priority)
);

CREATE TABLE IF NOT EXISTS customer_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  price DECIMAL(14,2) NOT NULL DEFAULT 0,
  image_path VARCHAR(255) NULL,
  contact_phone VARCHAR(40) NULL,
  contact_phone_secondary VARCHAR(40) NULL,
  contact_note VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_customer_products_active (is_active, display_order, id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  recipient_user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  title VARCHAR(160) NOT NULL,
  message VARCHAR(255) NOT NULL,
  entity_type VARCHAR(80) NULL,
  entity_id INT NULL,
  location_id INT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipient_user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id)
    ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_notifications_recipient (recipient_user_id, is_read, created_at),
  INDEX idx_notifications_entity (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS seedling_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  unit_number INT NOT NULL,
  unit_code VARCHAR(120) NOT NULL UNIQUE,
  qr_payload TEXT NULL,
  current_stage VARCHAR(50) NOT NULL DEFAULT 'cassette',
  is_defective TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id)
    ON DELETE CASCADE,
  INDEX idx_units_batch_id (batch_id),
  UNIQUE KEY uq_unit_batch_number (batch_id, unit_number)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NOT NULL,
  description VARCHAR(255) NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_activity_created_at (created_at),
  INDEX idx_activity_entity (entity_type, entity_id)
);

-- ===== MODUL 1: MOLIYAVIY TIZIM =====
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
  payment_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'paid',
  note TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_payments_order (order_id),
  INDEX idx_payments_date (payment_date)
);

-- ===== MODUL 2: CRM — MIJOZLAR =====
CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NULL,
  phone2 VARCHAR(40) NULL,
  email VARCHAR(120) NULL,
  address TEXT NULL,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_customers_name (name),
  INDEX idx_customers_active (is_active)
);

-- ===== MODUL 3: YETKAZIB BERISH =====
CREATE TABLE IF NOT EXISTS deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NULL,
  customer_id INT NULL,
  customer_name VARCHAR(160) NOT NULL,
  address TEXT NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  delivery_date DATE NOT NULL,
  delivery_time VARCHAR(20) NULL,
  driver_name VARCHAR(120) NULL,
  driver_phone VARCHAR(40) NULL,
  vehicle VARCHAR(80) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  note TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_deliveries_date (delivery_date),
  INDEX idx_deliveries_status (status)
);

-- ===== MODUL 4: AGROTEXNIK JURNALI =====
CREATE TABLE IF NOT EXISTS agro_journal (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT NULL,
  batch_id INT NULL,
  action_type VARCHAR(50) NOT NULL,
  action_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  quantity_used DECIMAL(10,2) NULL,
  unit VARCHAR(30) NULL,
  product_name VARCHAR(120) NULL,
  description TEXT NULL,
  performed_by INT NULL,
  image_paths LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_agro_date (action_date),
  INDEX idx_agro_type (action_type),
  INDEX idx_agro_location (location_id)
);

-- ===== MODUL 5: HR — DAVOMAT VA TOPSHIRIQLAR =====
CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  work_date DATE NOT NULL,
  check_in TIME NULL,
  check_out TIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'present',
  note VARCHAR(255) NULL,
  recorded_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_attendance (user_id, work_date),
  INDEX idx_attendance_date (work_date)
);

CREATE TABLE IF NOT EXISTS employee_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  assigned_to INT NULL,
  assigned_by INT NULL,
  location_id INT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  due_date DATE NULL,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  INDEX idx_tasks_status (status),
  INDEX idx_tasks_assigned (assigned_to)
);

-- ===== MODUL 6: TELEGRAM BOT SOZLAMALARI =====
CREATE TABLE IF NOT EXISTS telegram_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  telegram_chat_id VARCHAR(80) NULL,
  telegram_username VARCHAR(80) NULL,
  notify_new_order TINYINT(1) NOT NULL DEFAULT 1,
  notify_order_sold TINYINT(1) NOT NULL DEFAULT 1,
  notify_transfer TINYINT(1) NOT NULL DEFAULT 1,
  notify_low_stock TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_telegram_user (user_id)
);

-- ===== MODUL 7: SIFAT SERTIFIKATLARI =====
-- ===== TEPLITSA BOSQICH INVENTAR (partiyasiz, miqdor asosida) =====
-- Har bir teplitsada hozirgi holatda nechta ko'chat qaysi bosqichda
CREATE TABLE IF NOT EXISTS greenhouse_stage_stock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT NOT NULL,
  stage VARCHAR(50) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gss_location_stage (location_id, stage),
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  INDEX idx_gss_location (location_id)
);

-- Teplitsadagi barcha bosqich harakatlari jurnali (sana bo'yicha)
CREATE TABLE IF NOT EXISTS greenhouse_stage_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT NOT NULL,
  action_date DATE NOT NULL,
  from_stage VARCHAR(50) NULL,
  to_stage VARCHAR(50) NULL,
  quantity INT NOT NULL DEFAULT 0,
  notes TEXT NULL,
  image_paths LONGTEXT NULL,
  created_by INT NULL,
  source_transfer_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_gsl_location_date (location_id, action_date),
  INDEX idx_gsl_action_date (action_date)
);

CREATE TABLE IF NOT EXISTS certificates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  certificate_number VARCHAR(80) NOT NULL UNIQUE,
  batch_id INT NULL,
  order_id INT NULL,
  cert_type VARCHAR(50) NOT NULL DEFAULT 'quality',
  issued_to VARCHAR(160) NOT NULL,
  issued_by INT NULL,
  issue_date DATE NOT NULL,
  expiry_date DATE NULL,
  seedling_type VARCHAR(160) NULL,
  variety_name VARCHAR(160) NULL,
  quantity INT NOT NULL DEFAULT 0,
  location_name VARCHAR(160) NULL,
  notes TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES seedling_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_cert_number (certificate_number),
  INDEX idx_cert_status (status)
);

CREATE TABLE IF NOT EXISTS sensor_devices (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  location_id   INT NOT NULL,
  device_code   VARCHAR(60) NOT NULL UNIQUE,
  api_key       VARCHAR(80) NOT NULL UNIQUE,
  label         VARCHAR(120) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_seen_at  DATETIME NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  INDEX idx_sd_location (location_id),
  INDEX idx_sd_api_key (api_key)
);

CREATE TABLE IF NOT EXISTS temperature_readings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  device_id     INT NULL,
  location_id   INT NOT NULL,
  temperature   DECIMAL(5,2) NOT NULL,
  humidity      DECIMAL(5,2) NULL,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id)   REFERENCES sensor_devices(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  INDEX idx_tr_location_time (location_id, recorded_at),
  INDEX idx_tr_recorded_at   (recorded_at)
);

-- ===== BOSH OFES MODUL KONFIGURATSIYASI =====
CREATE TABLE IF NOT EXISTS bosh_ofes_modules (
  module_key VARCHAR(80) NOT NULL PRIMARY KEY,
  is_enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ===== TELEGRAM BOT GLOBAL KONFIGURATSIYASI =====
CREATE TABLE IF NOT EXISTS telegram_bot_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bot_token VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  admin_chat_id VARCHAR(80) NULL,
  site_url VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ===== BOT ORQALI KELGAN BUYURTMALAR =====
CREATE TABLE IF NOT EXISTS bot_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  telegram_user_id VARCHAR(80) NOT NULL,
  telegram_username VARCHAR(80) NULL,
  telegram_name VARCHAR(160) NULL,
  customer_product_id INT NULL,
  product_name VARCHAR(160) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  address TEXT NULL,
  phone VARCHAR(40) NULL,
  notes TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'new',
  order_ref_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_product_id) REFERENCES customer_products(id) ON DELETE SET NULL,
  INDEX idx_bot_orders_status (status),
  INDEX idx_bot_orders_tg_user (telegram_user_id)
);
