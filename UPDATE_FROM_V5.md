# Обновление с v0.5 до v0.6

1. Остановите старую локальную версию:

```powershell
docker compose down
```

2. Сохраните свои данные, особенно если запускаете проект локально:

```powershell
Copy-Item -Recurse -Force .\backend\data ..\gundone-data-backup
Copy-Item -Force .\.env ..\gundone-env-backup -ErrorAction SilentlyContinue
```

3. Распакуйте v0.6, верните в неё папку `backend/data` и свой `.env`.

4. Соберите и запустите:

```powershell
docker compose up --build
```

## Railway

Ничего вручную в SQLite переносить не нужно. После deployment backend сам добавит колонку `image_aspect_ratio`.

Проверьте два пункта:

- Volume backend смонтирован в `/app/data`;
- frontend пересобран после выставления `NEXT_PUBLIC_API_URL` с полным `https://`.

Старые карты не потеряют метки, регионы, объекты и связи со статьями. Их пропорции будут определяться автоматически при первом открытии. При следующей загрузке фона правильное соотношение сторон будет сохранено в базе.
