# Google Workspace Gateway

Aplikacja webowa pośredniczy pomiędzy agentem a Google Calendar i Google Tasks. Wielu użytkowników może zalogować się kontem Google, udzielić zgody, wybrać własny kalendarz lub listę zadań i włączyć publikację. OAuth, przechowywanie tokenów i wywołania Google API obsługuje gateway; agent korzysta z osobnego wewnętrznego REST API.

Projekt powstał dla [monitora występów Kraków](https://github.com/sigmalko/Cracow). Klient monitora w repozytorium Cracow obsługuje to API po skonfigurowaniu trybu `google`. Ta wersja jest punktem wyjścia do uruchomienia i testów; nie została przetestowana z prawdziwym kontem Google ani jako obraz Docker w środowisku autora zmian.

## Jak to działa

1. Użytkownik loguje się do aplikacji przez OpenID Connect. Dostęp mają tylko adresy wpisane w `ALLOWED_EMAILS` i potwierdzone przez Google.
2. Osobno zgadza się na dostęp Calendar i/lub Tasks. Publiczny HTTPS callback odbiera kod autoryzacyjny; aplikacja sprawdza `state`, PKCE, tożsamość i zakresy, a następnie wymienia kod na tokeny.
3. Użytkownik wybiera po jednym celu dla każdego typu. Jawne wybranie celu włącza publikację dla monitora; można ją wyłączyć, zmienić cel lub lokalnie odłączyć Google.
4. Aplikacja przechowuje refresh token w zaszyfrowanej bazie SQLite; na żądanie automatycznie odświeża access token. Gdy potrzebna jest ponowna zgoda, stan konta zmienia się na `reauthorization_required`.
5. Uprawniony proces monitora wyświetla aktywne subskrypcje i wysyła zweryfikowane dane do API. Nie otrzymuje tokenów Google. Klasyfikator modelowy nie powinien mieć dostępu do sekretu API ani wywoływać publikacji.

Wysyłający odpowiada za weryfikację prawdziwości i pochodzenia danych. Gateway sprawdza format, ale nie sprawdza stron wydarzeń ani nie stwierdza, czy wydarzenie odbywa się w Krakowie. Google Calendar wymaga początku i końca wydarzenia. W Tasks API termin zawiera tylko datę; godzina trafia do notatki. [Dokumentacja pola `due`](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## Wymagania

- VPS z publiczną domeną/subdomeną i DNS kierującym na serwer; dla callbacku Google wymagany jest publiczny HTTPS, nie surowy publiczny adres IP.
- Docker Engine i Docker Compose; otwarte TCP 443 oraz TCP 80 dla domyślnej automatycznej obsługi certyfikatu Caddy. Na tych portach nie może pracować inny serwer. Jeśli masz już proxy, dostosuj konfigurację i certyfikaty.
- Konto Google i projekt Google Cloud. Dla użytkowników różnych organizacji lub kont osobistych wybierz typ aplikacji **External**; dla użytkowników własnej organizacji może być **Internal**.
- Node.js 24 lub nowszy do uruchamiania/testowania poza Dockerem. Aplikacja używa `node:sqlite`, Express oraz oficjalnej biblioteki Google OAuth.

## Konfiguracja Google krok po kroku

1. W [Google Cloud Console](https://console.cloud.google.com/) utwórz projekt lub wybierz istniejący.
2. W **APIs & Services → Library** włącz **Google Calendar API** oraz **Google Tasks API**.
3. W **Google Auth Platform → Branding** skonfiguruj nazwę aplikacji, adres wsparcia i kontaktowy. W **Audience** wybierz Internal albo External. Dla External w stanie Testing dodaj adresy użytkowników jako **Test users**. W **Data Access** dodaj zakresy potrzebne aplikacji.
4. Aplikacja loguje użytkowników przez `openid` i `email`. Dla Calendar żąda `https://www.googleapis.com/auth/calendar.events.owned` oraz `https://www.googleapis.com/auth/calendar.calendarlist.readonly`; dlatego w panelu pokazuje tylko kalendarze, których użytkownik jest właścicielem. Dla Tasks żąda `https://www.googleapis.com/auth/tasks`. Zakres Tasks obejmuje wszystkie zadania, a zakres Calendar wszystkie własne kalendarze, także możliwość ich zmieniania i usuwania przez aplikację; wybór celu ogranicza działania samego gatewaya, nie uprawnienia Google tokenu. [Zakresy Calendar](https://developers.google.com/workspace/calendar/api/auth), [zakresy Tasks](https://developers.google.com/workspace/tasks/auth).
5. W **Google Auth Platform → Clients → Create Client** wybierz **Web application**. W **Authorized redirect URIs** dodaj dokładnie `https://TWOJA-DOMENA/oauth/google/callback` i utwórz klienta. Zapisz `client_id`; `client_secret` będzie potrzebny jako sekret na VPS. Ścieżka i ewentualny port muszą zgadzać się dokładnie z `BASE_URL` oraz konfiguracją proxy.
6. Google może wymagać weryfikacji aplikacji i domeny przy udostępnieniu na zewnątrz. W External + Testing refresh token dla tych zakresów zwykle wygasa po 7 dniach; są wyjątki organizacyjne. Administrator Workspace może ograniczyć dostęp. [Statusy OAuth](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

## Uruchomienie na VPS

Pobierz aplikację i wykonuj poniższe polecenia w jej katalogu:

```sh
git clone https://github.com/sigmalko/google-workspace-gateway.git
cd google-workspace-gateway
```

Nie wklejaj sekretów do Issues, rozmów ani repozytorium.

1. Skieruj DNS `A` na publiczne IPv4 VPS i, jeśli używasz IPv6, poprawnie skonfiguruj `AAAA`. Otwórz porty 80 i 443 w firewallu VPS i u dostawcy.
2. Skopiuj konfigurację i edytuj ją:

   ```sh
   cp .env.example .env
   ```

   Ustaw w `.env`: `DOMAIN` jako samą domenę, `BASE_URL` jako `https://` plus ta sama domena, `GOOGLE_CLIENT_ID` i `ALLOWED_EMAILS` jako adresy rozdzielone przecinkami. To lista użytkowników z dostępem; przed jej rozszerzeniem pamiętaj o Google Test users. Zmiana listy wymaga ponownego utworzenia kontenera. Usunięcie adresu z listy blokuje również jego subskrypcje w API.
3. Utwórz pliki sekretów poza Gitem:

   ```sh
   umask 077
   mkdir -p secrets
   openssl rand -base64 32 > secrets/encryption_key
   openssl rand -hex 32 > secrets/agent_token
   ```

   Utwórz `secrets/google_client_secret` w edytorze, wklejając sam **client secret** z Google Cloud, bez JSON i bez cudzysłowów. Nie umieszczaj wartości w poleceniach ani historii powłoki. Ustaw pliki na `0600`, a katalog `secrets` na `0700`. Kontener aplikacji działa jako UID/GID `1000:1000`; w zwykłym Dockerze bind-mount plików musi być czytelny dla tego UID (w razie potrzeby nadaj mu własność plików, np. `sudo chown 1000:1000 secrets/*`). W rootless Docker lub przy mapowaniu użytkowników dopasuj własność do mapowania. Klucz szyfrowania, client secret i token agenta są osobnymi sekretami.
4. Uruchom:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

   Caddy wystawia publicznie 80/443 i kieruje tylko ścieżki panelu oraz callback do aplikacji. `/internal/v1/*` nie jest wystawiane przez publiczne proxy. Proces gatewaya używa portu 8765 w sieci Dockera i nie publikuje go na hoście. Caddy nie ma włączonych access logów; filtr usuwa pole żądania z domyślnych logów. Przy dodawaniu innych proxy, monitoringu lub logów zadbaj, by nie zapisywały URL callbacku z `code` i `state`, ciastek i nagłówków.
5. Otwórz `https://TWOJA-DOMENA/`, zaloguj się do dozwolonego konta, wybierz połączenie Calendar/Tasks, zaakceptuj uprawnienia i wybierz kalendarz/listę. Najpierw użyj wydzielonego kalendarza i listy testowej. Do zmiany celu lub ponownego połączenia użytkownik ponownie korzysta z tej strony.
6. Przekaż zaufanemu monitorowi **wyłącznie osobny** `agent_token`, np. jako plik sekretu. Klucz ma dostęp do **wszystkich włączonych subskrypcji**: ta wersja nie ma oddzielnych kluczy i uprawnień dla wielu agentów. Przekazuj go tylko jednemu zaufanemu monitorowi i rotuj przez zmianę pliku oraz odtworzenie gatewaya i klienta. Konfigurację klienta opisuje [README monitora](https://github.com/sigmalko/Cracow#publikacja-do-google-calendar-i-google-tasks).

Monitor `Cracow` działa bezpośrednio z crona na hoście. Aby klient na tym samym VPS mógł dotrzeć do API bez uruchamiania w Dockerze, uruchom zamiast powyższego `docker compose -f compose.yaml -f compose.host.yaml up -d --build` i połącz się z `http://127.0.0.1:8765`. To opcjonalne mapowanie tylko na localhost; w Dockerze przed 28.0.0 inne hosty w tym samym segmencie L2 mogły je osiągnąć. Patrz [dokumentacja Dockera](https://docs.docker.com/engine/network/port-publishing/). Klient monitora dopuszcza HTTP tylko na adresie loopback. Jeśli monitor działa w osobnym kontenerze lub na innym hoście, skonfiguruj dla API osobny prywatny endpoint HTTPS z odpowiednią kontrolą dostępu; domyślny publiczny Caddy blokuje `/internal/v1/*`. Nie wystawiaj portu 8765 publicznie.

Baza jest w wolumenie `gateway_data`, a certyfikaty w wolumenie Caddy. Zatrzymaj aplikację przed wykonywaniem spójnej kopii bazy SQLite albo użyj mechanizmu kopii SQLite; wykonuj też zabezpieczone kopie sekretów, w tym klucza szyfrowania, oddzielnie od bazy. Utrata klucza uniemożliwi odszyfrowanie tokenów. Nie uruchamiaj wielu replik gatewaya na tej samej bazie: synchronizacja odświeżania tokenów jest tylko wewnątrz jednego procesu.

## Wewnętrzne API

Dla wszystkich wywołań dodaj `Authorization: Bearer <agent_token>`. To nie jest Google access token. Unikaj wpisywania sekretu w polecenie powłoki lub umieszczania go w argumentach procesu; klient powinien wczytywać go z pliku.

`GET /internal/v1/subscriptions` zwraca tylko identyfikatory i rodzaje włączonych celów dla dozwolonych, połączonych kont:

```json
{"subscriptions":[{"id":"identyfikator-subskrypcji","kind":"calendar"}]}
```

`POST /internal/v1/publications` wymaga dodatkowo stabilnego nagłówka `Idempotency-Key` i JSON:

```json
{
  "subscriptionId": "identyfikator-subskrypcji",
  "sourceEventId": "zrodlo:stabilny-id-wystepu",
  "category": "stand-up",
  "title": "Nazwa występu",
  "start": "2027-03-12T19:00:00+01:00",
  "end": "2027-03-12T20:30:00+01:00",
  "timeZone": "Europe/Warsaw",
  "venue": "Kraków, sala",
  "sourceUrl": "https://example.org/wystep",
  "verifiedAt": "2027-01-10T12:00:00Z"
}
```

Obowiązkowe: `subscriptionId`, `sourceEventId`, `title`, `start` i prawidłowa nazwa strefy IANA `timeZone`; `end` jest obowiązkowe dla Calendar i musi być późniejsze od początku. Jeśli `end` jest podane dla Tasks, jest również walidowane. Pozostałe pola są opcjonalne; adres źródła, jeżeli podany, musi być HTTPS. Daty używają RFC 3339 z offsetem. Dla monitora Kraków należy wypełnić pola źródła i czasu weryfikacji oraz stosować `Europe/Warsaw`; monitor sam ustala politykę brakującego czasu końca.

Wyniki: `201` / `created` po zapisie, `200` / `already_exists` dla tego samego klucza i danych, `409` / `idempotency_conflict` gdy ten sam klucz ma inne dane, `409` / `source_already_recorded` dla tego samego źródła z innym kluczem, `409` / `reauthorization_required` gdy potrzebna nowa zgoda, `503` przy problemie z uzyskaniem tokenu przed publikacją. `404` oznacza brak lub wyłączenie subskrypcji, `400` niepoprawne dane, `401` zły token usługi. Wartości kodów i statusów klient powinien obsługiwać jawnie.

Klucz i identyfikator źródła są niezależnie unikalne dla subskrypcji. Wybór innego celu tworzy inną subskrypcję, a powrót do poprzedniego zachowuje jej historię. `POST` nie ma trybu podglądu: `--dry-run` należy zrealizować w kliencie **bez wysyłania** żądania publikacji. Rekordy nie są automatycznie aktualizowane ani usuwane.

### Niepewny wynik

Przy awarii w trakcie zapisu pośrednik zwraca `409` / `uncertain`; ponowienie z tym samym kluczem nie wysyła drugi raz do Google. Nie twierdzimy, że da się zagwarantować dokładnie jeden zapis przez dwie niezależne usługi. Zatrzymaj ponawianie z monitora i sprawdź wynik:

```sh
docker compose exec gateway node src/resolve.mjs SUBSCRIPTION_ID IDEMPOTENCY_KEY --inspect
```

Inspekcja sprawdza Calendar po deterministycznym ID i znaczniku lub listę Tasks po znaczniku w notatce, z uwzględnieniem ukończonych i ukrytych zadań. Zwraca ID kandydatów, nie tokeny. Brak wyniku nie dowodzi, że zapis się nie powiódł; znaczniki mogą być usunięte lub zmienione, a dane mogą nie być jeszcze widoczne. Jeżeli ręcznie potwierdzono właściwy wpis i jego ID, oznacz go jako utworzony:

```sh
docker compose exec gateway node src/resolve.mjs SUBSCRIPTION_ID IDEMPOTENCY_KEY --created GOOGLE_ID
```

Dopiero po ustaleniu, że żaden wpis nie został utworzony, można jawnie zezwolić na ponowienie przez `--retry` zamiast `--created GOOGLE_ID`. Wykonuj uzgadnianie po zatrzymaniu monitora i innych operacji na danej subskrypcji. Jeśli wpisów jest kilka lub nie da się ustalić wyniku, nie ponawiaj automatycznie.

## Testy i ograniczenia

```sh
npm ci
npm test
npm audit --omit=dev
```

Testy używają lokalnego HTTP, bazy w pamięci i atrap Google: obejmują m.in. OAuth state/PKCE, odświeżanie, separację kont, CSRF, idempotencję, niepewne zapisy i daty. Nie łączą się z Google i nie tworzą wydarzeń. Przed produkcyjnym użyciem przetestuj pełny OAuth, odnawianie tokenów po restarcie, certyfikat, prywatność API i zapisy w wydzielonym kalendarzu/listach. Przygotuj ochronę przed nadużyciami/rate limiting na poziomie proxy, monitoring i procedurę kopii. Aktualnie brak per-agent ACL, automatycznych migracji schematu bazy, automatycznych aktualizacji/usuwania wydarzeń i rozproszonej synchronizacji replik. Projekt nie przeszedł niezależnego audytu bezpieczeństwa.
