// A minimal JSON API for the NAV "Go API" template.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"message": "Hello from Go on NAV", "service": os.Getenv("NAV_SERVICE_NAME"), "commit": os.Getenv("NAV_GIT_COMMIT")})
	})
	log.Printf("listening on %s", port)
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, nil))
}
