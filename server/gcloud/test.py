import requests

url = "https://shopee-e-commerce-data.p.rapidapi.com/v1/search_items"
query = {"keyword": "kacamata", "region": "ID", "page": "1"}

headers = {
    "X-RapidAPI-Key": "MASUKKAN_KEY_KAMU_DI_SINI",
    "X-RapidAPI-Host": "shopee-e-commerce-data.p.rapidapi.com"
}

r = requests.get(url, headers=headers, params=query)
print(r.status_code)
print(r.text[:500])