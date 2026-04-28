package main

import (
	"database/sql"
	"log"
	"runtime/debug"

	_ "github.com/go-sql-driver/mysql"
	"github.com/heylo-tech/go/backend/appsync/platformdb"
	"go.uber.org/zap"
)

// Injected at build time via -ldflags -X.
var (
	Environment  string
	DbConnection string
)

var (
	db        *sql.DB
	initError error
)

func init() {
	if DbConnection == "" {
		// Local dev default: MySQL on localhost, root user, no password, `heylo` db.
		// loc=UTC — DATETIME columns store UTC; without this the driver tags them as Local.
		DbConnection = "root@tcp(127.0.0.1:3306)/heylo?parseTime=true&loc=UTC"
	}

	db, initError = sql.Open("mysql", DbConnection)
	if initError != nil {
		panic(initError)
	}

	db.SetMaxOpenConns(3)
	db.SetMaxIdleConns(3)
}


func handler(event ResolverEvent) (retVal interface{}, retErr error) {
	defer func() {
		if err := recover(); err != nil {
			log.Printf("panic: %+v", err)
			log.Println("Stacktrace from panic:\n" + string(debug.Stack()))
			retErr = AppSyncError{Message: Unexpected}
		}
	}()

	logger, err := zap.NewProduction()
	if err != nil {
		log.Printf("Failed to initialize logger: %s", err)
		return nil, AppSyncError{Message: Unexpected}
	}
	defer logger.Sync()

	log.Printf("ParentType: %s. FieldName: %s", event.Info.ParentTypeName, event.Info.FieldName)

	if event.Identity == nil {
		return nil, AppSyncError{Message: Unauthorized}
	}
	claims := event.Identity.Claims
	if claims.PlatformUserID == "" || claims.PlatformRoleID == "" {
		return nil, AppSyncError{Message: Unauthorized}
	}

	userRole, err := platformdb.GetUserRole(db, claims.PlatformUserID, claims.PlatformRoleID, claims.PlatformAgencyID)
	if err != nil {
		log.Printf("GetUserRole failed: %v", err)
		return nil, AppSyncError{Message: Unexpected}
	}
	if userRole == nil {
		return nil, AppSyncError{Message: Unauthorized}
	}

	controller := &Controller{
		Logger:           logger,
		DB:               db,
		Environment:      Environment,
		CognitoUsername:  claims.CognitoUsername,
		PlatformAgencyID: claims.PlatformAgencyID,
		UserRole:         userRole,
	}

	switch event.Info.FieldName {
	case "getCaseloadSchedule":
		return GetCaseloadSchedule(event, controller)
	default:
		log.Printf("Field %s: no handler registered", event.Info.FieldName)
		return nil, AppSyncErrorResponse{
			Message: "Unexpected Error",
			Type:    "FieldWithNoHandler",
		}
	}
}
