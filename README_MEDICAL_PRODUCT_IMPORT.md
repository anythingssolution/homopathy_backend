# Medical Product Import

Medical login me product master import ke liye single-sheet Excel flow use hota hai.

## APIs

### CRUD

```http
GET /api/v1/medical/master-medical-products?search=&source_type=&status=active&page=1&limit=20
POST /api/v1/medical/master-medical-products
GET /api/v1/medical/master-medical-products/:id
PUT /api/v1/medical/master-medical-products/:id
DELETE /api/v1/medical/master-medical-products/:id
```

`DELETE` hard delete nahi karta; product ko `is_active = 0` mark karta hai.

Create/update payload:

```json
{
  "medicine_value": "Alfa Compound Syrup",
  "source_type": "REGULAR_PRODUCT",
  "product_name": "Alfa Compound Syrup",
  "product_type": "SYRUP",
  "category": "SYRUPS",
  "packing": "100 ML",
  "size_or_weight": "",
  "mrp_rate": 115,
  "price_min": "",
  "price_max": "",
  "shipper_size_pcs": "",
  "description": "",
  "formula_composition": "",
  "is_active": 1
}
```

Same `product_name` already exists ho to create/update reject hota hai.

### Excel

```http
GET /api/v1/medical/master-medical-products/template
```

Downloads `medical_products_import_template.xlsx`.

```http
POST /api/v1/medical/master-medical-products/import
Content-Type: multipart/form-data

file=<xlsx file>
```

Imports products into `master_text_medicines` and `master_medical_products`.

## Sheet

Sheet name: `medical_products`

Columns:

```text
medicine_value
source_type
product_name
product_type
category
packing
size_or_weight
mrp_rate
price_min
price_max
shipper_size_pcs
description
formula_composition
is_active
```

Allowed `source_type` values:

```text
REGULAR_PRODUCT
RADIENT_PHARMA
MEDICAL_PRODUCT_PRICE
```

## Duplicate Rule

Same `product_name` current import ya existing `master_medical_products` me already hai to row insert nahi hogi.

Response me skipped rows reason ke saath milenge:

```json
{
  "success": true,
  "message": "Medical products import completed",
  "data": {
    "inserted_medicines": 0,
    "inserted_products": 0,
    "skipped_rows": [
      {
        "row_number": 2,
        "product_name": "ACIDOLIV SYRUP",
        "reason": "Product name already exists in master_medical_products as \"ACIDOLIV SYRUP\""
      }
    ],
    "total_skipped_rows": 1
  }
}
```
